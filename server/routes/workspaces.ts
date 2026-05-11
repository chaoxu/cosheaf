import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth } from "../middleware.js";
import { provisionWorkspace } from "../workspace-provisioning.js";

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

  // Reject early if the slug is taken locally — avoids reaching Forgejo.
  const taken = db.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(body.slug);
  if (taken) return c.json({ error: "slug already taken", code: "conflict" }, 409);

  try {
    const { workspace } = await provisionWorkspace(db, fj, config, {
      slug: body.slug,
      name: body.name,
      user,
      forgejoUsername: fjUser,
      rollbackCreatedRepoOnLocalFailure: true,
    });
    return c.json(
      { id: workspace.id, slug: body.slug, name: body.name, role: "owner" },
      201,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE") || (err as Error).message === "workspace slug already exists") {
      return c.json({ error: "slug already taken", code: "conflict" }, 409);
    }
    return c.json(
      { error: `workspace create failed: ${(err as Error).message}`, code: "internal" },
      500,
    );
  }
});
