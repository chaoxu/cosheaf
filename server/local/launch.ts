// `cosheaf-workbench <dir>` — the local Workbench entrypoint.
//
// Points a local cosheaf server at a folder on disk: derive the workspace
// identity, build a LocalGitWorkspaceBackend over the working tree, index its
// pages into a sidecar under <dir>/.cosheaf, and serve the same rich Coflat
// reader/editor the hosted app does — with no forge, no auth, no network.
//
// Run from the cosheaf repo root (so the built island manifest + public assets
// resolve): `pnpm workbench <dir>`. Requires `pnpm build` to have produced
// dist/.vite/manifest.json — the editor island loads from the built manifest.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { createApp } from "../app.js";
import { buildLocalConfig, getDb } from "../db.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { workspaceSlug } from "../../shared/conventions.js";
import { indexCitationFile, indexPage } from "../indexer.js";
import { SSEHub } from "../sse.js";
import type { LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { deriveLocalWorkspace } from "./local-workspace.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Best-effort: ignore failures (no browser, headless, etc.).
  execFile(cmd, [url], () => undefined);
}

async function indexWorkspace(
  db: ReturnType<typeof getDb>,
  backend: LocalGitWorkspaceBackend,
  identity: LocalWorkspaceIdentity,
): Promise<{ pages: number; bibs: number }> {
  const { owner, repo, defaultMdFormat } = identity;
  const slug = workspaceSlug(owner, repo);
  const tree = await backend.getTree(owner, repo, "main", true);
  let pages = 0;
  let bibs = 0;
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (fileKindForPath(entry.path) === "markdown") {
      const content = await backend.getRawFile(owner, repo, "main", entry.path);
      indexPage(db, { workspaceSlug: slug, filePath: entry.path, bodyText: content, formatId: defaultMdFormat });
      pages++;
    } else if (entry.path.toLowerCase().endsWith(".bib")) {
      const content = await backend.getRawFile(owner, repo, "main", entry.path);
      indexCitationFile(db, { workspaceSlug: slug, filePath: entry.path, bodyText: content });
      bibs++;
    }
  }
  return { pages, bibs };
}

async function run(dirArg: string): Promise<void> {
  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`);
    process.exit(1);
  }
  // The editor island loads from the built manifest; force production asset mode
  // and require the build to exist.
  process.env.NODE_ENV = "production";
  if (!existsSync(resolve(process.cwd(), "dist/.vite/manifest.json"))) {
    console.error("missing dist/.vite/manifest.json — run `pnpm build` first (from the cosheaf repo root).");
    process.exit(1);
  }

  const ws = deriveLocalWorkspace(dir);
  const backend = new LocalGitWorkspaceBackend(dir);
  const identity: LocalWorkspaceIdentity = {
    owner: ws.owner,
    repo: ws.repo,
    defaultMdFormat: ws.defaultMdFormat,
    user: ws.owner,
    title: ws.repo,
    // Tier 2: opening a PR needs a configured remote + Cosheaf token.
    canOpenPull: ws.remote !== null,
  };

  const config = buildLocalConfig({ dataDir: resolve(dir, ".cosheaf"), port: 0 });
  const db = getDb(config);
  const { pages, bibs } = await indexWorkspace(db, backend, identity);

  const app = createApp({ config, db, sse: new SSEHub(), workspaceBackend: backend, localWorkspace: identity });

  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
    const url = `http://127.0.0.1:${info.port}/`;
    console.log(`\n  Cosheaf Workbench`);
    console.log(`  folder:    ${dir}`);
    console.log(`  workspace: ${identity.owner}/${identity.repo}  (${identity.defaultMdFormat})`);
    console.log(`  remote:    ${ws.remote ? ws.remote.url : "none (local-only)"}`);
    console.log(`  indexed:   ${pages} page${pages === 1 ? "" : "s"}, ${bibs} bib file${bibs === 1 ? "" : "s"}`);
    console.log(`\n  → ${url}\n`);
    if (process.env.COSHEAF_NO_OPEN !== "1") openBrowser(url);
  });
}

const program = new Command();
program
  .name("cosheaf-workbench")
  .description("Open a local folder in the Cosheaf Workbench (rich Coflat editor over working-tree files).")
  .argument("<dir>", "folder to open as a workspace")
  .action((dir: string) => {
    void run(dir);
  });
program.parse();
