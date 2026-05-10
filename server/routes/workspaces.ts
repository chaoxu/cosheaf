import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { indexPage } from "../indexer.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

workspaces.get("/", (c) => {
  const rows = c
    .get("db")
    .prepare(
      "SELECT workspaces.id AS id, workspaces.slug AS slug, workspaces.name AS name, " +
        "workspaces.forgejo_repo AS forgejo_repo, memberships.role AS role " +
        "FROM workspaces JOIN memberships ON memberships.workspace_id = workspaces.id " +
        "WHERE memberships.user_id = ? ORDER BY workspaces.name",
    )
    .all(c.get("user").id) as Array<{
      id: number;
      slug: string;
      name: string;
      forgejo_repo: string;
      role: "owner" | "verifier" | "member";
    }>;
  return c.json({ workspaces: rows.map(({ forgejo_repo: _drop, ...rest }) => rest) });
});

workspaces.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: string; name?: string } | null;
  if (!body?.slug || !body.name)
    return c.json({ error: "slug and name required", code: "validation" }, 400);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(body.slug))
    return c.json({ error: "invalid slug", code: "validation" }, 400);

  const db = c.get("db");
  const config = c.get("config");
  const fj = c.get("forgejo");
  const user = c.get("user");
  const fjUser = c.get("forgejoUsername");
  const repoName = body.slug;

  // Reject early if the slug is taken locally — avoids reaching Forgejo.
  const taken = db.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(body.slug);
  if (taken) return c.json({ error: "slug already taken", code: "conflict" }, 409);

  // Step 1: ensure Forgejo repo first. If we fail, no sidecar row gets orphaned.
  const owner = config.forgejoOwner;
  let repoExisted = false;
  let createdRepoForRollback = false;
  try {
    const existing = await fj.getRepo(owner, repoName);
    if (existing) {
      repoExisted = true;
    } else {
      await fj.createUserRepo({
        name: repoName,
        description: body.name,
        private: true,
        auto_init: true,
        default_branch: "main",
      }, owner);
      createdRepoForRollback = true;
    }
  } catch (err) {
    return c.json(
      { error: `forgejo repo create failed: ${(err as Error).message}`, code: "internal" },
      500,
    );
  }

  // Step 2: create local workspace + membership row. Rollback the Forgejo repo if it fails.
  const tx = db.transaction(() => {
    const wsRow = db
      .prepare(
        "INSERT INTO workspaces (slug, name, forgejo_repo, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(body.slug, body.name, repoName, Date.now()) as { id: number };
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
    ).run(wsRow.id, user.id);
    return wsRow;
  });
  let ws: { id: number };
  try {
    ws = tx();
  } catch (err) {
    if (createdRepoForRollback) {
      try {
        await fj.deleteRepo(owner, repoName);
      } catch (rollbackErr) {
        console.warn(`rollback delete failed: ${(rollbackErr as Error).message}`);
      }
    }
    if ((err as Error).message.includes("UNIQUE"))
      return c.json({ error: "slug already taken", code: "conflict" }, 409);
    throw err;
  }

  // Step 3: add the workspace creator as a write collaborator (so their proxy can push).
  if (fjUser !== owner) {
    try {
      await fj.addCollaborator(owner, repoName, fjUser, "write");
    } catch (err) {
      // 204 success or 409 already-collaborator are fine.
      if (!(err instanceof ForgejoError && err.status === 409)) {
        // Don't roll back — workspace is created; permissions can be repaired manually.
        console.warn(`addCollaborator failed: ${(err as Error).message}`);
      }
    }
  }

  // Step 4: branch protection (auto-merge when threshold met). Default min_approvals = 1.
  try {
    const existing = await fj.getBranchProtection(owner, repoName, "main");
    if (!existing) {
      await fj.createBranchProtection(owner, repoName, {
        branch_name: "main",
        required_approvals: 1,
        push_whitelist_usernames: [fjUser],
      });
    } else {
      await fj.patchBranchProtectionPushWhitelist(owner, repoName, "main", [fjUser]);
    }
  } catch (err) {
    console.warn(`branch protection setup failed: ${(err as Error).message}`);
  }

  // Step 5: webhook — only on the first time we created this repo. Idempotent check.
  try {
    const hooks = await fj.listRepoHooks(owner, repoName);
    const hasOurHook = hooks.some((h) => Array.isArray(h.events) && h.events.includes("push"));
    if (!hasOurHook) {
      await fj.createRepoHook(
        owner,
        repoName,
        config.webhookUrl,
        config.webhookSecret,
        ["push", "pull_request", "pull_request_review", "pull_request_comment", "issues", "issue_comment"],
      );
    }
  } catch (err) {
    console.warn(`webhook setup failed: ${(err as Error).message}`);
  }

  // Step 6: ensure .gitattributes exists with byte-exact lock for *.md (only on a fresh repo).
  if (!repoExisted) {
    try {
      await fj.putFile(owner, repoName, {
        branch: "main",
        path: ".gitattributes",
        content: "*.md text eol=lf -text\n",
        message: "chore: lock byte-exactness for .md",
        sudo: fjUser,
      });
    } catch (err) {
      console.warn(`.gitattributes setup failed: ${(err as Error).message}`);
    }
  }

  // Step 7: backfill the sidecar index from main's tree. Files that pre-existed
  // in the repo (Forgejo's auto-init README, or existing content if reusing a repo)
  // didn't fire webhooks against this adapter; index them now so search and
  // backlinks work.
  try {
    const tree = await fj.getTree(owner, repoName, "main", true);
    for (const entry of tree) {
      if (entry.type !== "blob" || !entry.path.endsWith(".md")) continue;
      try {
        const body = await fj.getRawFile(owner, repoName, "main", entry.path);
        indexPage(db, { workspaceId: ws.id, filePath: entry.path, bodyText: body });
      } catch (err) {
        console.warn(`backfill ${entry.path} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`backfill tree failed: ${(err as Error).message}`);
  }

  return c.json(
    { id: ws.id, slug: body.slug, name: body.name, role: "owner" },
    201,
  );
});
