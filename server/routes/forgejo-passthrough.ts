// Forgejo REST passthrough.
//
// Agents trained on Forgejo's API can hit Forgejo directly through cosheaf:
//
//   {METHOD} /api/v1/w/{slug}/forgejo/{tail}
//   -> {METHOD} {forgejoUrl}/api/v1/repos/{owner}/{repo}/{tail}
//   with `Authorization: token <caller Forgejo PAT>`.
//
// Cosheaf handles auth (cookie session or `Bearer <Forgejo PAT>`) and
// workspace scoping (path is anchored at the
// workspace's repo so an agent cannot stumble into another repo or /admin/*).
// Body and query are forwarded verbatim; response status, content-type, and
// Link header are forwarded.
//
// Policy (intentional, see AGENTS.md):
//
// - **Passthrough is the agent surface.** Forgejo-trained bots talk through
//   here. The typed routes (routes/pulls.ts, routes/issues.ts,
//   routes/files.ts, routes/branches.ts, routes/notifications.ts) are the
//   *human-UI surface* — they shape responses for the SPA, run validation,
//   integrate with the SQLite sidecar, and emit SSE.
// - **Don't add a typed route just to wrap a Forgejo endpoint 1:1.** If the
//   SPA only needs raw Forgejo JSON, use passthrough from the client.
// - **Don't add to passthrough what already has a typed route.** Merging is
//   the canonical example: `pulls/:n/merge` is forbidden below because
//   /pulls/:n/merge goes through `requireAdminFresh`. Same logic applies if
//   we later add cosheaf-side checks to a typed route.
//
// Rate limiting is a follow-up. Forgejo's own access log records every
// forwarded request; cosheaf no longer mirrors it.

import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { forbidden, methodNotAllowed } from "./responses.js";

// Tail prefixes we forward. `methods` lists which HTTP verbs are allowed
// for that prefix.
//
// `branches` and `contents` are GET-only on purpose: cosheaf has
// dedicated, validated endpoints for branch creation and file writes
// that apply content conventions and (for files) synchronous indexing.
// Letting them through the passthrough would bypass those gates.
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
const ALLOWED: Array<{ prefix: string; methods: ReadonlySet<Method> }> = [
  { prefix: "pulls",            methods: new Set<Method>(["GET", "POST", "PATCH", "DELETE"]) },
  { prefix: "issues",           methods: new Set<Method>(["GET", "POST", "PATCH", "PUT", "DELETE"]) },
  { prefix: "labels",           methods: new Set<Method>(["GET", "POST", "PATCH", "DELETE"]) },
  { prefix: "milestones",       methods: new Set<Method>(["GET", "POST", "PATCH", "DELETE"]) },
  { prefix: "branches",         methods: new Set<Method>(["GET"]) },
  { prefix: "commits",          methods: new Set<Method>(["GET"]) },
  { prefix: "contents",         methods: new Set<Method>(["GET"]) },
  { prefix: "reviews",          methods: new Set<Method>(["GET", "POST"]) },
  { prefix: "markdown",         methods: new Set<Method>(["POST"]) },
  { prefix: "activities/feeds", methods: new Set<Method>(["GET"]) },
  { prefix: "notifications",    methods: new Set<Method>(["GET", "PUT"]) },
];

// Tails that, no matter what prefix matched, must never be forwarded.
// `pulls/*/merge` bypasses `requireAdminFresh`; admins should merge
// through cosheaf's typed `/pulls/:n/merge` route, not raw passthrough.
const FORBIDDEN_RE = [/^pulls\/\d+\/merge(\/|\?|$)/];

function classifyTail(tail: string, method: string): "ok" | "method" | "forbidden" {
  const pathPart = tail.split("?")[0];
  for (const re of FORBIDDEN_RE) {
    if (re.test(tail)) return "forbidden";
  }
  for (const { prefix, methods } of ALLOWED) {
    const matches = pathPart === prefix || pathPart.startsWith(prefix + "/");
    if (!matches) continue;
    return methods.has(method as Method) ? "ok" : "method";
  }
  return "forbidden";
}

// Cheap path-traversal / cross-repo guard. The wildcard already strips the
// `/api/v1/w/{slug}/forgejo/` prefix, so `tail` is whatever the agent put
// after `/forgejo/`. We reject anything that could climb out of the repo's
// namespace or smuggle a leading slash.
function isSafeTail(tail: string): boolean {
  if (tail.length === 0) return false;
  if (tail.startsWith("/")) return false;
  const pathPart = tail.split("?")[0];
  // Reject any percent-encoded dot, slash, or backslash. These survive
  // WHATWG URL normalization as literal text but may be decoded by Forgejo's
  // own path parser, opening a workspace-scope escape. See #52.
  if (/%2e|%2f|%5c/i.test(pathPart)) return false;
  // Reject `..` anywhere in the path, not just as a whole segment — covers
  // edge cases like `pulls/..%2fadmin` once we've stripped the encoded `/`.
  if (pathPart.includes("..")) return false;
  // No re-anchoring into another repo or admin path. These are caught by
  // the whitelist too, but be explicit for defense in depth.
  if (tail.startsWith("repos/")) return false;
  if (tail.startsWith("admin/") || tail === "admin") return false;
  return true;
}

export const forgejoPassthrough = new Hono<AppEnv>();
forgejoPassthrough.use("*", requireAuth);
forgejoPassthrough.use("/:slug/*", requireMembership());

forgejoPassthrough.all("/:slug/forgejo/*", async (c) => {
  const slug = c.req.param("slug");
  const config = c.get("config");
  const { owner, repo } = c.get("repoCtx");

  // Extract tail from the URL. Use c.req.url so we get the original
  // (decoded-by-fetch) pathname + query exactly as the client sent them.
  const reqUrl = new URL(c.req.url);
  const prefix = `/api/v1/w/${slug}/forgejo/`;
  if (!reqUrl.pathname.startsWith(prefix)) {
    return c.json(...forbidden("passthrough path not allowed"));
  }
  const tailPath = reqUrl.pathname.slice(prefix.length);
  const queryString = reqUrl.search; // includes leading "?" or ""

  if (!isSafeTail(tailPath)) {
    return c.json(...forbidden("passthrough path not allowed"));
  }
  const method = c.req.method.toUpperCase();
  const verdict = classifyTail(tailPath, method);
  if (verdict === "method") {
    return c.json(...methodNotAllowed("method not allowed for this path"));
  }
  if (verdict === "forbidden") {
    return c.json(...forbidden("passthrough path not allowed"));
  }

  // Build the Forgejo URL.
  const target = new URL(
    `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${tailPath}${queryString}`,
    config.forgejoUrl,
  );
  // Belt-and-suspenders: after `new URL(...)` normalizes any traversal that
  // slipped past isSafeTail (#52), the pathname must still live under this
  // workspace's repo. Reject otherwise instead of forwarding the caller's PAT
  // to an arbitrary Forgejo endpoint.
  const expectedPrefix = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/`;
  if (!target.pathname.startsWith(expectedPrefix)) {
    return c.json(...forbidden("passthrough escaped workspace scope"));
  }

  // Forward with the caller's own Forgejo PAT — same trust model as the
  // typed routes. The PAT comes from the request's Authorization header
  // and is set on the context by requireAuth.
  const fwdHeaders: Record<string, string> = {
    authorization: `token ${c.get("forgejoToken")}`,
    accept: c.req.header("accept") ?? "application/json",
  };
  const ct = c.req.header("content-type");
  if (ct) fwdHeaders["content-type"] = ct;

  // Buffer the request body. Fine for v1 — agents are not pushing huge
  // payloads through here.
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;

  let status = 0;
  let respBody: ArrayBuffer = new ArrayBuffer(0);
  let respContentType: string | null = null;
  let respLink: string | null = null;
  try {
    const res = await fetch(target, {
      method,
      headers: fwdHeaders,
      body: body && body.byteLength > 0 ? body : undefined,
    });
    status = res.status;
    respContentType = res.headers.get("content-type");
    respLink = res.headers.get("link");
    respBody = await res.arrayBuffer();
  } catch (err) {
    status = 502;
    respContentType = "application/json";
    respBody = new TextEncoder().encode(
      JSON.stringify({ error: "forgejo unreachable", code: "bad_gateway", detail: (err as Error).message }),
    ).buffer as ArrayBuffer;
  }
  const outHeaders: Record<string, string> = {};
  if (respContentType) outHeaders["content-type"] = respContentType;
  if (respLink) outHeaders.link = respLink;
  const outBody = status === 204 || status === 304 ? null : respBody;
  return new Response(outBody, { status, headers: outHeaders });
});
