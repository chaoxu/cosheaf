import type Database from "better-sqlite3";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import { ForgejoError } from "./forgejo.js";
import { deletePage, indexPage } from "./indexer.js";
import type { User } from "./users.js";

// Forgejo events we subscribe to. The cosheaf webhook handler in
// `server/routes/webhooks.ts` switches on these exact strings — if you
// add to this list, add a handler branch too, or Forgejo will keep
// re-delivering an event we always 200-noop.
const WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "issues",
  "issue_comment",
];

export interface WorkspaceRow {
  id: number;
  slug: string;
  name: string;
  forgejo_repo: string;
}

export interface ProvisionWorkspaceOptions {
  slug: string;
  name: string;
  user: User;
  forgejoUsername: string;
  allowExistingLocal?: boolean;
  rollbackCreatedRepoOnLocalFailure?: boolean;
}

export interface ProvisionWorkspaceResult {
  workspace: WorkspaceRow;
  repoExisted: boolean;
  createdRepo: boolean;
}

export async function provisionWorkspace(
  db: Database.Database,
  forgejo: Forgejo,
  config: Config,
  options: ProvisionWorkspaceOptions,
): Promise<ProvisionWorkspaceResult> {
  const owner = config.forgejoOwner;
  const repoName = options.slug;
  let repoExisted = false;
  let createdRepo = false;

  const existingRepo = await forgejo.getRepo(owner, repoName);
  if (existingRepo) {
    repoExisted = true;
  } else {
    await forgejo.createUserRepo(
      {
        name: repoName,
        description: options.name,
        private: true,
        auto_init: true,
        default_branch: "main",
      },
      owner,
    );
    createdRepo = true;
  }

  // Provisioning is a sequence with side effects in different stores (Forgejo
  // + local DB). If any required step fails after we create the Forgejo repo
  // / local row, roll both back so a retry sees a clean slate. The optional
  // reindex is best-effort.
  let workspace: WorkspaceRow;
  const rollback = async (err: unknown): Promise<never> => {
    try {
      db.prepare("DELETE FROM workspaces WHERE slug = ?").run(options.slug);
    } catch (cleanupErr) {
      console.warn(`rollback local delete failed: ${(cleanupErr as Error).message}`);
    }
    if (createdRepo && options.rollbackCreatedRepoOnLocalFailure) {
      try {
        await forgejo.deleteRepo(owner, repoName);
      } catch (rollbackErr) {
        console.warn(`rollback delete failed: ${(rollbackErr as Error).message}`);
      }
    }
    throw err;
  };

  try {
    workspace = upsertWorkspace(db, options, repoName);
  } catch (err) {
    return rollback(err);
  }

  try {
    await ensureWorkspacePermissions(forgejo, config, repoName, options.forgejoUsername);
    // Webhook setup is required — without it, the sidecar will diverge from
    // Forgejo silently. Let failures roll the workspace back so the operator
    // can retry instead of finding out via stale data weeks later.
    await ensureWorkspaceWebhookOrThrow(forgejo, config, repoName);
    if (!repoExisted) {
      await ensureWorkspaceFile(forgejo, config, repoName, options.forgejoUsername, {
        path: ".gitattributes",
        content: "*.md text eol=lf -text\n",
        message: "chore: lock byte-exactness for .md",
      });
    }
  } catch (err) {
    return rollback(err);
  }

  try {
    await reindexWorkspaceFromForgejo(db, forgejo, config, workspace);
  } catch (err) {
    console.warn(`workspace reindex failed: ${(err as Error).message}`);
  }

  return { workspace, repoExisted, createdRepo };
}

function upsertWorkspace(
  db: Database.Database,
  options: ProvisionWorkspaceOptions,
  repoName: string,
): WorkspaceRow {
  const existing = db
    .prepare("SELECT id, slug, name, forgejo_repo FROM workspaces WHERE slug = ?")
    .get(options.slug) as WorkspaceRow | undefined;
  if (existing && !options.allowExistingLocal) {
    throw new Error("workspace slug already exists");
  }

  if (existing) {
    db.prepare("UPDATE workspaces SET name = ?, forgejo_repo = ? WHERE id = ?")
      .run(options.name, repoName, existing.id);
    return { ...existing, name: options.name, forgejo_repo: repoName };
  }

  return db
    .prepare(
      "INSERT INTO workspaces (slug, name, forgejo_repo, created_at) VALUES (?, ?, ?, ?) " +
        "RETURNING id, slug, name, forgejo_repo",
    )
    .get(options.slug, options.name, repoName, Date.now()) as WorkspaceRow;
}

export async function ensureWorkspacePermissions(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
  forgejoUsername: string,
): Promise<void> {
  if (forgejoUsername !== config.forgejoOwner) {
    try {
      // The creator becomes the workspace owner — Forgejo "admin" so they can
      // change settings (e.g. branch protection) and direct-merge.
      await forgejo.addCollaborator(config.forgejoOwner, repoName, forgejoUsername, "admin");
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 409)) {
        console.warn(`addCollaborator failed: ${(err as Error).message}`);
      }
    }
  }

  try {
    const existing = await forgejo.getBranchProtection(config.forgejoOwner, repoName, "main");
    if (!existing) {
      await forgejo.createBranchProtection(config.forgejoOwner, repoName, {
        branch_name: "main",
        required_approvals: 1,
        push_whitelist_usernames: [forgejoUsername],
      });
    } else {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, repoName, "main", [forgejoUsername]);
    }
  } catch (err) {
    console.warn(`branch protection setup failed: ${(err as Error).message}`);
  }
}

async function ensureWorkspaceWebhookOrThrow(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
): Promise<void> {
  const hooks = await forgejo.listRepoHooks(config.forgejoOwner, repoName);
  const hasOurHook = hooks.some((h) => Array.isArray(h.events) && h.events.includes("push"));
  if (!hasOurHook) {
    await forgejo.createRepoHook(
      config.forgejoOwner,
      repoName,
      config.webhookUrl,
      config.webhookSecret,
      WEBHOOK_EVENTS,
    );
  }
}

export async function ensureWorkspaceFile(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
  forgejoUsername: string,
  file: { path: string; content: string; message: string },
): Promise<boolean> {
  const meta = await forgejo.getFileMeta(config.forgejoOwner, repoName, "main", file.path);
  if (meta) return false;
  await forgejo.putFile(config.forgejoOwner, repoName, {
    branch: "main",
    path: file.path,
    content: file.content,
    message: file.message,
    sudo: forgejoUsername,
  });
  return true;
}

export async function reindexWorkspaceFromForgejo(
  db: Database.Database,
  forgejo: Forgejo,
  config: Config,
  workspace: Pick<WorkspaceRow, "id" | "forgejo_repo">,
): Promise<number> {
  const seen = new Set<string>();
  const tree = await forgejo.getTree(config.forgejoOwner, workspace.forgejo_repo, "main", true);
  const mdPaths = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => e.path);
  // Fetch all markdown bodies in parallel — each getRawFile is independent
  // and the indexPage write that follows is local. Note Forgejo rate limits
  // aren't a concern at this volume (one workspace's tree).
  const bodies = await Promise.all(
    mdPaths.map((path) =>
      forgejo
        .getRawFile(config.forgejoOwner, workspace.forgejo_repo, "main", path)
        .then((body) => ({ path, body })),
    ),
  );
  for (const { path, body } of bodies) {
    indexPage(db, { workspaceId: workspace.id, filePath: path, bodyText: body });
    seen.add(path);
  }

  const indexed = db
    .prepare("SELECT forgejo_id FROM doc_map WHERE workspace_id = ?")
    .all(workspace.id) as Array<{ forgejo_id: string }>;
  for (const row of indexed) {
    if (!seen.has(row.forgejo_id)) deletePage(db, workspace.id, row.forgejo_id);
  }
  return seen.size;
}
