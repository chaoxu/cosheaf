import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { createToken, listTokens, revokeToken } from "../auth.js";
import { requireAuth } from "../middleware.js";

export const tokens = new Hono<AppEnv>();

tokens.use("*", requireAuth);

tokens.get("/", (c) => {
  const user = c.get("user");
  return c.json({ tokens: listTokens(c.get("db"), user.id) });
});

tokens.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim();
  if (!name) return c.json({ error: "name required", code: "validation" }, 400);
  const user = c.get("user");
  const created = createToken(c.get("db"), user.id, name);
  return c.json({ id: created.id, name, token: created.token }, 201);
});

tokens.delete("/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "invalid id", code: "validation" }, 400);
  const user = c.get("user");
  const ok = revokeToken(c.get("db"), user.id, id);
  if (!ok) return c.json({ error: "not found", code: "not_found" }, 404);
  return c.json({ ok: true });
});
