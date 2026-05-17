// Login = Forgejo PAT exchange. Cosheaf doesn't hold passwords or proxy
// users; the user types their Forgejo username + password into cosheaf's
// form, cosheaf forwards those creds (HTTP Basic) to Forgejo's
// /users/:user/tokens endpoint, and the returned PAT is encrypted and
// stored. Later API calls use that PAT — no admin token, no `Sudo:` header.

import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { AppEnv } from "../types.js";
import {
  createSession,
  destroySession,
  setStoredPat,
  upsertUserFromForgejo,
  userFromSession,
} from "../users.js";

export const auth = new Hono<AppEnv>();

// Token name we reserve in Forgejo for cosheaf-issued PATs. There is at most
// one of these per user at a time: each successful login deletes any existing
// `cosheaf` token and creates a fresh one.
const TOKEN_NAME = "cosheaf";

// Scopes cosheaf needs. Forgejo's PAT scopes are documented at
// https://forgejo.org/docs/latest/admin/oauth2-provider/ — we ask for what
// the routes touch and nothing more.
const TOKEN_SCOPES = [
  "read:repository",
  "write:repository",
  "read:issue",
  "write:issue",
  "read:user",
  "read:notification",
  "write:notification",
];

interface CreateTokenResponse { sha1: string }

async function exchangeForgejoCredsForPat(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  const url = `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`;
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const headers = {
    authorization: `Basic ${basic}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const body = JSON.stringify({ name: TOKEN_NAME, scopes: TOKEN_SCOPES });

  const create = async () => fetch(url, { method: "POST", headers, body });
  let res = await create();
  if (res.status === 422) {
    // Name already in use from a previous session — delete and retry.
    const del = await fetch(`${url}/${TOKEN_NAME}`, { method: "DELETE", headers });
    if (!del.ok && del.status !== 404) return null;
    res = await create();
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return null;
  const parsed = (await res.json().catch(() => null)) as CreateTokenResponse | null;
  return parsed?.sha1 ?? null;
}

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body?.username || !body.password)
    return c.json({ error: "missing credentials", code: "validation" }, 400);

  const config = c.get("config");
  const pat = await exchangeForgejoCredsForPat(config.forgejoUrl, body.username, body.password);
  if (!pat) return c.json({ error: "invalid credentials", code: "unauthorized" }, 401);

  const db = c.get("db");
  const user = upsertUserFromForgejo(db, body.username);
  setStoredPat(db, user.id, pat, config.sessionSecret);

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
