// In-app git Smart-HTTP proxy. Lets a user clone/fetch/push a workspace over
// git from cosheaf's own domain — `git clone https://<pat>@cosheaf/owner/repo.git`
// — without ever touching the Forgejo URL. Cosheaf authenticates the request
// (the cosheaf PAT is the git password), runs the same membership gate as every
// other route (read to fetch, write to push), and stream-proxies git's
// pkt-line/packfile traffic to Forgejo's git endpoints using the caller's own
// credential. This is the same "validate membership → backend credential"
// translation the typed API does, applied to git transport; it reshapes
// nothing, so it is not a raw REST passthrough.

import { Hono } from "hono";
import { Forgejo, ForgejoError } from "../forgejo.js";
import { resolveRepoRole } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { FORGEJO_NAME_RE } from "../../shared/conventions.js";

export const gitProxy = new Hono<AppEnv>();

// The git client sends HTTP Basic auth with the PAT as the password (the
// username is whatever the user typed and is not load-bearing — the PAT alone
// identifies the caller).
export function basicPat(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
    return pass || null;
  } catch (_err) {
    return null;
  }
}

// `:repo` arrives as `<name>.git`; strip the suffix and validate. Returns null
// for a non-git request so it falls through to the rest of the app.
export function parseGitRepo(owner: string | undefined, repoDotGit: string | undefined): { owner: string; repo: string } | null {
  if (!owner || !repoDotGit || !repoDotGit.endsWith(".git")) return null;
  const repo = repoDotGit.slice(0, -".git".length);
  if (!FORGEJO_NAME_RE.test(owner) || !FORGEJO_NAME_RE.test(repo)) return null;
  return { owner, repo };
}

type GitAuth = { pat: string; username: string } | { challenge: true } | { status: 404 | 403 };

async function authorize(
  baseUrl: string,
  authHeader: string | undefined,
  owner: string,
  repo: string,
  need: "read" | "write",
): Promise<GitAuth> {
  const pat = basicPat(authHeader);
  if (!pat) return { challenge: true };
  const fj = new Forgejo({ baseUrl, token: pat });
  let username: string;
  try {
    username = (await fj.getCurrentUser()).login;
  } catch (err) {
    if (err instanceof ForgejoError && (err.status === 401 || err.status === 403)) return { challenge: true };
    throw err;
  }
  const role = await resolveRepoRole(fj, owner, repo, username);
  // 404 (not 403) for no access, matching the web anti-enumeration convention.
  if (role === "none") return { status: 404 };
  if (need === "write" && role !== "write" && role !== "admin") return { status: 403 };
  return { pat, username };
}

// Stream the git request through to Forgejo's matching git endpoint and stream
// the response back, preserving the git content types and the request/response
// bodies (pkt-lines and packfiles) untouched.
async function proxy(
  baseUrl: string,
  owner: string,
  repo: string,
  subpath: string,
  search: string,
  username: string,
  pat: string,
  req: Request,
): Promise<Response> {
  const url = `${baseUrl}/${owner}/${repo}.git/${subpath}${search}`;
  const headers = new Headers();
  for (const h of ["content-type", "accept", "content-encoding", "git-protocol"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("authorization", `Basic ${Buffer.from(`${username}:${pat}`).toString("base64")}`);
  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: req.method === "POST" ? req.body : undefined,
    // Node fetch requires this when streaming a request body.
    ...(req.method === "POST" ? { duplex: "half" } : {}),
  } as RequestInit);
  const respHeaders = new Headers();
  for (const h of ["content-type", "content-encoding", "cache-control", "expires", "pragma"]) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function challenge(): Response {
  return new Response("authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Cosheaf"', "content-type": "text/plain" },
  });
}

// GET /:owner/:repo.git/info/refs?service=git-(upload|receive)-pack — the
// capability advertisement git fetches first. service tells us read vs write.
gitProxy.get("/:owner/:repo/info/refs", async (c) => {
  const parsed = parseGitRepo(c.req.param("owner"), c.req.param("repo"));
  if (!parsed) return c.notFound();
  const service = c.req.query("service");
  if (service !== "git-upload-pack" && service !== "git-receive-pack") return c.notFound();
  const baseUrl = c.get("config").forgejoUrl;
  const auth = await authorize(baseUrl, c.req.header("authorization"), parsed.owner, parsed.repo, service === "git-receive-pack" ? "write" : "read");
  if ("challenge" in auth) return challenge();
  if ("status" in auth) return c.text(auth.status === 404 ? "not found" : "forbidden", auth.status);
  return proxy(baseUrl, parsed.owner, parsed.repo, "info/refs", `?service=${service}`, auth.username, auth.pat, c.req.raw);
});

// POST .../git-upload-pack — clone/fetch (read).
gitProxy.post("/:owner/:repo/git-upload-pack", async (c) => {
  const parsed = parseGitRepo(c.req.param("owner"), c.req.param("repo"));
  if (!parsed) return c.notFound();
  const baseUrl = c.get("config").forgejoUrl;
  const auth = await authorize(baseUrl, c.req.header("authorization"), parsed.owner, parsed.repo, "read");
  if ("challenge" in auth) return challenge();
  if ("status" in auth) return c.text(auth.status === 404 ? "not found" : "forbidden", auth.status);
  return proxy(baseUrl, parsed.owner, parsed.repo, "git-upload-pack", "", auth.username, auth.pat, c.req.raw);
});

// POST .../git-receive-pack — push (write).
gitProxy.post("/:owner/:repo/git-receive-pack", async (c) => {
  const parsed = parseGitRepo(c.req.param("owner"), c.req.param("repo"));
  if (!parsed) return c.notFound();
  const baseUrl = c.get("config").forgejoUrl;
  const auth = await authorize(baseUrl, c.req.header("authorization"), parsed.owner, parsed.repo, "write");
  if ("challenge" in auth) return challenge();
  if ("status" in auth) return c.text(auth.status === 404 ? "not found" : "forbidden", auth.status);
  return proxy(baseUrl, parsed.owner, parsed.repo, "git-receive-pack", "", auth.username, auth.pat, c.req.raw);
});
