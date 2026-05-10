import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../types.js";
import {
  createSession,
  destroySession,
  ensureForgejoProxy,
  findUserByUsername,
  userFromSession,
  verifyPassword,
} from "../users.js";

export const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { username?: string; password?: string } | null;
  if (!body?.username || !body.password)
    return c.json({ error: "missing credentials", code: "validation" }, 400);
  const db = c.get("db");
  const user = findUserByUsername(db, body.username);
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: "invalid credentials", code: "unauthorized" }, 401);
  }
  await ensureForgejoProxy(db, c.get("forgejo"), user);
  const sessionId = createSession(db, user.id);
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return c.json({ id: user.id, username: user.username });
});

auth.post("/logout", (c) => {
  const sid = getCookie(c, "session");
  if (sid) {
    destroySession(c.get("db"), sid);
    deleteCookie(c, "session", { path: "/" });
  }
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const sid = getCookie(c, "session");
  if (!sid) return c.json({ user: null });
  const u = userFromSession(c.get("db"), sid);
  if (!u) return c.json({ user: null });
  return c.json({ user: { id: u.id, username: u.username } });
});
