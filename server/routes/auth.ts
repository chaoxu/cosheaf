import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../types.js";
import {
  createSession,
  destroySession,
  findUserByUsername,
  userFromSession,
  verifyPassword,
} from "../auth.js";

export const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { username?: string; password?: string } | null;
  if (!body?.username || !body.password) return c.json({ error: "missing credentials" }, 400);

  const db = c.get("db");
  const user = findUserByUsername(db, body.username);
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const sessionId = createSession(db, user.id);
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return c.json({ id: user.id, username: user.username });
});

auth.post("/logout", (c) => {
  const sessionId = getCookie(c, "session");
  if (sessionId) {
    destroySession(c.get("db"), sessionId);
    deleteCookie(c, "session", { path: "/" });
  }
  return c.json({ ok: true });
});

auth.get("/me", (c) => {
  const sessionId = getCookie(c, "session");
  if (!sessionId) return c.json({ user: null });
  const user = userFromSession(c.get("db"), sessionId);
  return c.json({ user });
});
