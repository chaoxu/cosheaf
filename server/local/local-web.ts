// The local Workbench's server-rendered web router — a deliberately small subset
// of the hosted `web` router. It mounts only the forge-free, backend-driven
// surfaces a single on-disk folder needs (repo landing, file src/raw pages, the
// read/edit workbench, page search), plus a home redirect and an inert /login
// backstop. The hosted issue/pull/settings/account/admin pages are NOT mounted:
// they read the raw forge client, which is absent in local mode.

import { Hono } from "hono";
import { compress } from "hono/compress";
import { repoHref } from "../../shared/url.js";
import type { AppEnv } from "../types.js";
import { redirect } from "../routes/web-context.js";
import { registerFileRoutes } from "../routes/web-files.js";
import { registerLocalCommitRoutes } from "./local-commit.js";

export function createLocalWebRouter(owner: string, repo: string): Hono<AppEnv> {
  const localWeb = new Hono<AppEnv>();
  localWeb.use("*", compress());

  // Home → the single workspace landing (GitHub-Desktop "open folder" feel).
  localWeb.get("/", () => redirect(repoHref(owner, repo)));

  // Local mode has no auth, so /login can never be reached legitimately. Keep a
  // backstop redirect so a stray bounce (e.g. the editor island's api.ts 401
  // path) lands on the workspace instead of dead-ending on a missing route.
  localWeb.get("/login", () => redirect("/"));
  localWeb.get("/logout", () => redirect("/"));

  // Tier 2: after the editor opens a PR it navigates to /:owner/:repo/pulls/:n.
  // The PR lives on the remote Cosheaf, so bounce there. 404 when no remote.
  localWeb.get("/:owner/:repo/pulls/:n{[0-9]+}", (c) => {
    const remote = c.get("remoteCosheaf");
    if (!remote) return c.notFound();
    return redirect(remote.pullUrl(c.req.param("owner"), c.req.param("repo"), Number(c.req.param("n"))));
  });

  // The repo landing, file tree/src/raw pages, and the read/edit workbench —
  // all resolve through the local branch of resolveWebRepo and read
  // ctx.backend, so they work against the working tree unchanged.
  registerFileRoutes(localWeb);
  registerLocalCommitRoutes(localWeb);

  return localWeb;
}
