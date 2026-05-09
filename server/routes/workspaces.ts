import { Hono } from "hono";
import { mkdirSync } from "node:fs";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth } from "../middleware.js";

export const workspaces = new Hono<AppEnv>();

workspaces.use("*", requireAuth);

workspaces.get("/", (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const rows = db
    .prepare(
      "SELECT workspaces.id AS id, workspaces.slug AS slug, workspaces.name AS name, memberships.role AS role " +
        "FROM workspaces JOIN memberships ON memberships.workspace_id = workspaces.id " +
        "WHERE memberships.user_id = ? ORDER BY workspaces.name",
    )
    .all(user.id);
  return c.json({ workspaces: rows });
});

workspaces.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: string; name?: string } | null;
  if (!body?.slug || !body.name)
    return c.json({ error: "slug and name required", code: "validation" }, 400);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(body.slug))
    return c.json({ error: "invalid slug", code: "validation" }, 400);

  const db = c.get("db");
  const user = c.get("user");

  const tx = db.transaction(() => {
    const ws = db
      .prepare("INSERT INTO workspaces (slug, name, created_at) VALUES (?, ?, ?) RETURNING id")
      .get(body.slug, body.name, Date.now()) as { id: number };
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
    ).run(ws.id, user.id);
    return ws;
  });

  let ws: { id: number };
  try {
    ws = tx();
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE"))
      return c.json({ error: "slug already taken", code: "conflict" }, 409);
    throw err;
  }

  mkdirSync(workspaceDir(c.get("config"), body.slug), { recursive: true });
  return c.json({ id: ws.id, slug: body.slug, name: body.name, role: "owner" }, 201);
});
