// Login exchanges user credentials for a Cosheaf-issued Forgejo PAT. Cosheaf
// doesn't hold passwords or sessions; the returned PAT supports API clients as
// JSON and server-rendered pages as an HttpOnly cookie.

import { Hono } from "hono";
import type Database from "better-sqlite3";
import { deleteCookie, setCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../types.js";
import { AUTH_COOKIE, resolveAuth } from "../middleware.js";
import { bad, unauthorized } from "./responses.js";

export const auth = new Hono<AppEnv>();

// Token name prefix for cosheaf-issued tokens. Names are intentionally unique per
// login so an automated smoke login as the same Forgejo user does not revoke an
// existing browser tab's cookie-backed PAT.
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
interface ForgejoUserResponse { login?: string }
interface CachedLoginToken {
  pat: string;
  token_name: string;
}

export type LoginOutcome =
  | { kind: "ok"; pat: string }
  | { kind: "bad_credentials" }
  | { kind: "upstream_unavailable"; detail: string };

type CreateTokenOutcome =
  | { kind: "created"; pat: string }
  | { kind: "name_taken" }
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
  db: Database.Database,
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const previous = loginQueues.get(username) ?? Promise.resolve();
  const run = (async (): Promise<LoginOutcome> => {
    await previous.catch(() => undefined);
    return exchangeForgejoCredsForPatRaw(db, baseUrl, username, password);
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
  db: Database.Database,
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const cached = db
    .prepare("SELECT pat, token_name FROM login_tokens WHERE username = ?")
    .get(username) as CachedLoginToken | undefined;
  if (cached) {
    const credentialCheck = await createForgejoToken(baseUrl, username, password, cached.token_name);
    if (credentialCheck.kind === "bad_credentials" || credentialCheck.kind === "upstream_unavailable") {
      return credentialCheck;
    }
    if (credentialCheck.kind === "created") {
      storeLoginToken(db, username, credentialCheck.pat, cached.token_name);
      return { kind: "ok", pat: credentialCheck.pat };
    }

    const patCheck = await verifyStoredPat(baseUrl, username, cached.pat);
    if (patCheck.kind === "ok") return { kind: "ok", pat: cached.pat };
    if (patCheck.kind !== "bad_credentials") return patCheck;
    db.prepare("DELETE FROM login_tokens WHERE username = ?").run(username);

    const reminted = await mintAndStoreLoginToken(db, baseUrl, username, password);
    if (reminted.kind === "ok") return reminted;
    if (reminted.kind === "bad_credentials") {
      return { kind: "upstream_unavailable", detail: "cached token was revoked and token name is unavailable" };
    }
    return reminted;
  }

  return mintAndStoreLoginToken(db, baseUrl, username, password);
}

async function mintAndStoreLoginToken(
  db: Database.Database,
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const tokenName = `${TOKEN_NAME_PREFIX}-${randomUUID()}`;
  const created = await createForgejoToken(baseUrl, username, password, tokenName);
  if (created.kind === "created") {
    storeLoginToken(db, username, created.pat, tokenName);
    return { kind: "ok", pat: created.pat };
  }
  if (created.kind === "name_taken") {
    return { kind: "upstream_unavailable", detail: "token name already exists" };
  }
  return created;
}

async function createForgejoToken(
  baseUrl: string,
  username: string,
  password: string,
  tokenName: string,
): Promise<CreateTokenOutcome> {
  const url = `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`;
  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const headers = {
    authorization: `Basic ${basic}`,
    "content-type": "application/json",
    accept: "application/json",
  };
  const body = JSON.stringify({ name: tokenName, scopes: TOKEN_SCOPES });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body });
  } catch (err) {
    return { kind: "upstream_unavailable", detail: (err as Error).message };
  }
  if (res.status === 401 || res.status === 403) return { kind: "bad_credentials" };
  if (res.status === 400 || res.status === 422) return { kind: "name_taken" };
  if (res.status >= 500 || res.status === 429) {
    return { kind: "upstream_unavailable", detail: `forgejo ${res.status}` };
  }
  if (!res.ok) {
    return { kind: "upstream_unavailable", detail: `forgejo ${res.status}` };
  }
  const parsed = (await res.json().catch(() => null)) as CreateTokenResponse | null;
  if (!parsed?.sha1) return { kind: "upstream_unavailable", detail: "missing sha1 in response" };
  return { kind: "created", pat: parsed.sha1 };
}

function storeLoginToken(
  db: Database.Database,
  username: string,
  pat: string,
  tokenName: string,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO login_tokens (username, pat, token_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      pat = excluded.pat,
      token_name = excluded.token_name,
      updated_at = excluded.updated_at
  `).run(username, pat, tokenName, now, now);
}

async function verifyStoredPat(
  baseUrl: string,
  username: string,
  pat: string,
): Promise<LoginOutcome> {
  return verifyForgejoUser(baseUrl, username, `token ${pat}`);
}

async function verifyForgejoUser(
  baseUrl: string,
  username: string,
  authorization: string,
): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/user`, {
      headers: { authorization, accept: "application/json" },
    });
  } catch (err) {
    return { kind: "upstream_unavailable", detail: (err as Error).message };
  }
  if (res.status === 401 || res.status === 403) return { kind: "bad_credentials" };
  if (res.status >= 500 || res.status === 429) {
    return { kind: "upstream_unavailable", detail: `forgejo ${res.status}` };
  }
  if (!res.ok) return { kind: "upstream_unavailable", detail: `forgejo ${res.status}` };

  const parsed = (await res.json().catch(() => null)) as ForgejoUserResponse | null;
  if (parsed?.login !== username) return { kind: "bad_credentials" };
  return { kind: "ok", pat: "" };
}

auth.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (!body?.username || !body.password)
    return c.json(...bad("missing credentials"));

  const config = c.get("config");
  const outcome = await exchangeForgejoCredsForPat(
    c.get("db"),
    config.forgejoUrl,
    body.username,
    body.password,
  );
  if (outcome.kind === "bad_credentials") {
    return c.json(...unauthorized("invalid credentials"));
  }
  if (outcome.kind === "upstream_unavailable") {
    return c.json(
      { error: `forgejo unavailable: ${outcome.detail}`, code: "bad_gateway" },
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

// Logout clears the browser cookie. We deliberately do NOT revoke the cached
// Forgejo PAT because other API clients may still use it.
auth.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const a = await resolveAuth(c);
  if (!a) return c.json({ user: null });
  return c.json({ user: { username: a.user.username } });
});
