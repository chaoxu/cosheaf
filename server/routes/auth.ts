// Login exchanges user credentials for a backend token. Cosheaf doesn't hold
// passwords or sessions; the returned token supports API/SPAs as JSON and
// server-rendered pages as an HttpOnly cookie.

import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../types.js";
import { AUTH_COOKIE, resolveAuth } from "../middleware.js";
import { bad, unauthorized } from "./responses.js";

export const auth = new Hono<AppEnv>();

// Token name prefix for cosheaf-issued tokens. Names are intentionally unique per
// login so an automated smoke login as the same Forgejo user does not revoke an
// existing browser tab's localStorage PAT.
const TOKEN_NAME_PREFIX = "cosheaf";

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

export type LoginOutcome =
  | { kind: "ok"; pat: string }
  | { kind: "bad_credentials" }
  | { kind: "upstream_unavailable"; detail: string };

// Per-username serialization for the PAT-exchange flow. Two simultaneous
// logins for the same user would otherwise race on the 422-retry path: the
// loser's DELETE of `cosheaf` would clobber the winner's freshly-issued
// token. Forgejo doesn't expose stored token shas (only at creation) so we
// can't compare-and-swap; serialize locally instead. Caveat: only effective
// within one cosheaf process. Multi-process deployments would still race.
const loginQueues = new Map<string, Promise<void>>();

export async function exchangeForgejoCredsForPat(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const previous = loginQueues.get(username) ?? Promise.resolve();
  const run = (async (): Promise<LoginOutcome> => {
    await previous.catch(() => undefined);
    return exchangeForgejoCredsForPatRaw(baseUrl, username, password);
  })();
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  loginQueues.set(username, tail);
  try {
    return await run;
  } finally {
    if (loginQueues.get(username) === tail) loginQueues.delete(username);
  }
}

async function exchangeForgejoCredsForPatRaw(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const url = `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`;
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const headers = {
    authorization: `Basic ${basic}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const tokenName = `${TOKEN_NAME_PREFIX}-${randomUUID()}`;
  const body = JSON.stringify({ name: tokenName, scopes: TOKEN_SCOPES });

  // Forgejo returns 400 (current) or 422 (older) when the token name is
  // already taken. The name includes a UUID, so this should be effectively
  // impossible; treat it as an upstream failure instead of deleting another
  // login's still-valid token.
  const create = async () => fetch(url, { method: "POST", headers, body });
  let res: Response;
  try {
    res = await create();
  } catch (err) {
    return { kind: "upstream_unavailable", detail: (err as Error).message };
  }
  if (res.status === 401 || res.status === 403) return { kind: "bad_credentials" };
  if (res.status >= 500 || res.status === 429) {
    return { kind: "upstream_unavailable", detail: `backend ${res.status}` };
  }
  if (!res.ok) {
    return { kind: "upstream_unavailable", detail: `backend ${res.status}` };
  }
  const parsed = (await res.json().catch(() => null)) as CreateTokenResponse | null;
  if (!parsed?.sha1) return { kind: "upstream_unavailable", detail: "missing sha1 in response" };
  return { kind: "ok", pat: parsed.sha1 };
}

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body?.username || !body.password)
    return c.json(...bad("missing credentials"));

  const config = c.get("config");
  const outcome = await exchangeForgejoCredsForPat(config.forgejoUrl, body.username, body.password);
  if (outcome.kind === "bad_credentials") {
    return c.json(...unauthorized("invalid credentials"));
  }
  if (outcome.kind === "upstream_unavailable") {
    return c.json(
      { error: `backend unavailable: ${outcome.detail}`, code: "bad_gateway" },
      502,
    );
  }
  setCookie(c, AUTH_COOKIE, outcome.pat, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.req.url.startsWith("https://"),
  });
  return c.json({ username: body.username, pat: outcome.pat });
});

// Logout is a no-op on the server: there is no session to destroy and we
// deliberately do NOT revoke the backend token (the user might be logged in
// from another device with the same token). The SPA drops its local copy
// of the token; the next login mints a fresh one.
auth.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const a = await resolveAuth(c);
  if (!a) return c.json({ user: null });
  return c.json({ user: { username: a.user.username } });
});
