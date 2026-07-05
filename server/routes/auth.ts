// Login validates user credentials with Forgejo, keeps the backend credential
// server-side, and returns an opaque Cosheaf token for API clients and
// server-rendered pages.

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { deleteApiToken, mintApiToken } from "../api-tokens.js";
import { AUTH_COOKIE, bearerToken, invalidateBearerCache, requireAuth, resolveAuth } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { bad, unauthorized } from "./responses.js";
import { rejectCrossOriginMutation, setAuthCookie } from "./web-context.js";

export const auth = new Hono<AppEnv>();

// Token name prefix for cosheaf-issued tokens. Names are intentionally unique per
// login so an automated smoke login as the same Forgejo user does not revoke an
// existing browser tab's cookie-backed PAT.
const TOKEN_NAME_PREFIX = "cosheaf";

// Scopes cosheaf needs. Forgejo's PAT scopes are documented at
// https://forgejo.org/docs/latest/admin/oauth2-provider/ — we ask for what
// the routes touch and nothing more. Cosheaf acts as a frontend over the
// forge, so the token must cover what the user can do: repository content +
// settings (write:repository), issues, notifications, and creating
// repositories under the user (write:user) or an org (write:organization).
const TOKEN_SCOPES = [
  "read:repository",
  "write:repository",
  "read:issue",
  "write:issue",
  "read:user",
  "write:user",
  "read:organization",
  "write:organization",
  "read:notification",
  "write:notification",
];

// Stable signature of the scope set a cached PAT was minted with (#148). Sorted
// so reordering TOKEN_SCOPES doesn't force a spurious re-mint; it changes only
// when a scope is added or removed. Stored on each login_tokens row; a cached
// row whose stored signature no longer matches is re-minted on next login.
const TOKEN_SCOPES_SIGNATURE = [...TOKEN_SCOPES].sort().join(",");
const TOKEN_MINT_ATTEMPTS = 3;

interface CreateTokenResponse { sha1: string }
interface ForgejoUserResponse { login?: string }
interface CachedLoginToken {
  username: string;
  pat: string;
  token_name: string;
  scopes: string | null;
}

export type LoginOutcome =
  | { kind: "ok"; username: string; pat: string }
  | { kind: "bad_credentials" }
  | { kind: "upstream_unavailable"; detail: string };

type CreateTokenOutcome =
  | { kind: "created"; pat: string }
  | { kind: "name_taken" }
  | { kind: "bad_credentials" }
  | { kind: "upstream_unavailable"; detail: string };

type VerifyUserOutcome =
  | { kind: "ok"; username: string }
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
  const queueKey = username.toLowerCase();
  const previous = loginQueues.get(queueKey) ?? Promise.resolve();
  const run = (async (): Promise<LoginOutcome> => {
    await previous.catch(() => undefined);
    return exchangeForgejoCredsForPatRaw(db, baseUrl, username, password);
  })();
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  loginQueues.set(queueKey, tail);
  try {
    return await run;
  } finally {
    if (loginQueues.get(queueKey) === tail) loginQueues.delete(queueKey);
  }
}

async function exchangeForgejoCredsForPatRaw(
  db: Database.Database,
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const cached = db
    .prepare(`
      SELECT username, pat, token_name, scopes
      FROM login_tokens
      WHERE username = ? COLLATE NOCASE
      ORDER BY username = ? DESC, updated_at DESC
      LIMIT 1
    `)
    .get(username, username) as CachedLoginToken | undefined;
  if (cached) {
    // The scope set changed since this token was minted (or the row predates
    // scope-versioning, scopes === null). Serving it would 403 on routes that
    // need the new scope, so re-mint with the current scopes (#148).
    // storeLoginToken upserts on username, so this replaces the stale row in
    // place — and on a transient mint failure it simply re-mints next login.
    if (cached.scopes !== TOKEN_SCOPES_SIGNATURE) {
      return mintAndStoreLoginToken(db, baseUrl, username, password);
    }
    const credentialCheck = await createForgejoToken(baseUrl, username, password, cached.token_name);
    if (credentialCheck.kind === "bad_credentials" || credentialCheck.kind === "upstream_unavailable") {
      return credentialCheck;
    }
    if (credentialCheck.kind === "created") {
      return storeVerifiedLoginToken(db, baseUrl, username, credentialCheck.pat, cached.token_name);
    }

    const patCheck = await verifyStoredPat(baseUrl, username, cached.pat);
    if (patCheck.kind === "ok") {
      storeLoginToken(db, patCheck.username, cached.pat, cached.token_name);
      deleteLoginTokenAliases(db, patCheck.username);
      return { kind: "ok", username: patCheck.username, pat: cached.pat };
    }
    if (patCheck.kind !== "bad_credentials") return patCheck;
    db.prepare("DELETE FROM login_tokens WHERE username = ?").run(cached.username);

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
  for (let attempt = 0; attempt < TOKEN_MINT_ATTEMPTS; attempt++) {
    const tokenName = `${TOKEN_NAME_PREFIX}-${randomUUID()}`;
    const created = await createForgejoToken(baseUrl, username, password, tokenName);
    if (created.kind === "created") {
      return storeVerifiedLoginToken(db, baseUrl, username, created.pat, tokenName);
    }
    if (created.kind !== "name_taken") return created;
  }
  return { kind: "upstream_unavailable", detail: "token name already exists" };
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

async function storeVerifiedLoginToken(
  db: Database.Database,
  baseUrl: string,
  submittedUsername: string,
  pat: string,
  tokenName: string,
): Promise<LoginOutcome> {
  const verified = await verifyStoredPat(baseUrl, submittedUsername, pat);
  if (verified.kind !== "ok") return verified;
  storeLoginToken(db, verified.username, pat, tokenName);
  deleteLoginTokenAliases(db, verified.username);
  return { kind: "ok", username: verified.username, pat };
}

function storeLoginToken(
  db: Database.Database,
  username: string,
  pat: string,
  tokenName: string,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO login_tokens (username, pat, token_name, scopes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      pat = excluded.pat,
      token_name = excluded.token_name,
      scopes = excluded.scopes,
      updated_at = excluded.updated_at
  `).run(username, pat, tokenName, TOKEN_SCOPES_SIGNATURE, now, now);
}

function deleteLoginTokenAliases(db: Database.Database, canonicalUsername: string): void {
  db.prepare("DELETE FROM login_tokens WHERE username = ? COLLATE NOCASE AND username <> ?")
    .run(canonicalUsername, canonicalUsername);
}

async function verifyStoredPat(
  baseUrl: string,
  username: string,
  pat: string,
): Promise<VerifyUserOutcome> {
  return verifyForgejoUser(baseUrl, username, `token ${pat}`);
}

async function verifyForgejoUser(
  baseUrl: string,
  username: string,
  authorization: string,
): Promise<VerifyUserOutcome> {
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
  if (!parsed?.login || parsed.login.toLowerCase() !== username.toLowerCase()) return { kind: "bad_credentials" };
  return { kind: "ok", username: parsed.login };
}

auth.post("/login", async (c) => {
  const crossOrigin = rejectCrossOriginMutation(c, { allowOriginless: true });
  if (crossOrigin) return crossOrigin;
  const body = (await c.req.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  if (typeof body?.username !== "string" || !body.username || typeof body.password !== "string" || !body.password)
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
  const apiToken = mintApiToken(c.get("db"), outcome.username, outcome.pat);
  setAuthCookie(c, apiToken);
  return c.json({ username: outcome.username, pat: apiToken, token_type: "cosheaf" });
});

// Logout clears the browser cookie and deletes the presented Cosheaf API token.
// We deliberately do NOT revoke the cached server-side Forgejo credential
// because other Cosheaf API tokens for the same user may still use it.
auth.post("/logout", (c) => {
  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return crossOrigin;
  const token = bearerToken(c.req.header("authorization")) ?? getCookie(c, AUTH_COOKIE) ?? null;
  if (token) {
    deleteApiToken(c.get("db"), token);
    // Evict the resolved-token cache too: deleting only the DB row leaves the
    // cached resolution (with a still-valid shared Forgejo credential) able to
    // keep authenticating the revoked token, since no backend 401 ever fires.
    invalidateBearerCache(token);
  }
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/version", (c) => c.json({ version: "cosheaf" }));

auth.get("/users/search", requireAuth, async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const rawLimit = Number(c.req.query("limit") ?? 10);
  const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 10;
  const users = q ? await c.get("fjUser").searchUsers(q, limit) : [];
  return c.json({ users: users.map((user) => ({ login: user.login })).filter((user) => user.login) });
});

auth.get("/user", async (c) => {
  const a = await resolveAuth(c);
  if (!a) return c.json(...unauthorized("not authenticated"));
  return c.json({
    id: 0,
    login: a.user.username,
    login_name: a.user.username,
    username: a.user.username,
    full_name: "",
    email: "",
    avatar_url: "",
    language: "en-US",
    is_admin: false,
    last_login: null,
    created: null,
    restricted: false,
    active: true,
    prohibit_login: false,
    location: "",
    website: "",
    description: "",
    visibility: "public",
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
  });
});

auth.get("/user/keys", async (c) => {
  const a = await resolveAuth(c);
  if (!a) return c.json(...unauthorized("not authenticated"));
  return c.json([]);
});

auth.get("/me", async (c) => {
  const a = await resolveAuth(c);
  if (!a) return c.json({ user: null });
  return c.json({ user: { username: a.user.username } });
});
