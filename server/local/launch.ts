// `cosheaf-workbench [dir]` — the local Workbench entrypoint.
//
// Serves the rich Coflat reader/editor over folders on disk, with no forge, no
// auth, no network. State lives in a central sidecar under ~/.cosheaf/workbench:
// a shared SQLite index plus a workspaces.json registry of opened folders, so a
// single Workbench switches between projects instead of one folder per process.
//
// `pnpm workbench` reopens whatever was registered before (home = the switcher);
// `pnpm workbench <dir>` also opens that folder. Requires `pnpm build` to have
// produced dist/.vite/manifest.json — the editor island loads from the manifest.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Command } from "commander";
import { createApp } from "../app.js";
import { resolveAppRoot } from "../app-root.js";
import { buildLocalConfig, getDb } from "../db.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Best-effort: ignore failures (no browser, headless, etc.).
  execFile(cmd, [url], () => undefined);
}

async function run(dirArg: string | undefined): Promise<void> {
  // The editor island loads from the built manifest; force production asset mode
  // and require the build to exist.
  process.env.NODE_ENV = "production";
  // Tier-2 over HTTPS to an internal-CA host (e.g. cosheaf-test.lab) needs the CA
  // trusted via NODE_EXTRA_CA_CERTS, which Node only reads at process start. The
  // bundle shim exports it from COSHEAF_CA_FILE before node runs; for `pnpm
  // workbench` (no shim) it is too late to set here, so warn instead of silently
  // failing the first push.
  if (process.env.COSHEAF_CA_FILE && !process.env.NODE_EXTRA_CA_CERTS) {
    console.warn(
      `warning: COSHEAF_CA_FILE is set but NODE_EXTRA_CA_CERTS is not — set it before launch, e.g.\n` +
        `  NODE_EXTRA_CA_CERTS=${process.env.COSHEAF_CA_FILE} pnpm workbench <dir>`,
    );
  }
  const appRoot = resolveAppRoot();
  if (!existsSync(resolve(appRoot, "dist/.vite/manifest.json"))) {
    console.error(
      process.env.COSHEAF_APP_ROOT
        ? `missing dist/.vite/manifest.json under COSHEAF_APP_ROOT=${appRoot} — the bundle is incomplete.`
        : "missing dist/.vite/manifest.json — run `pnpm build` first (from the cosheaf repo root).",
    );
    process.exit(1);
  }

  const home = join(homedir(), ".cosheaf", "workbench");
  const config = buildLocalConfig({ dataDir: home, port: 0 });
  const db = getDb(config);
  const registry = new WorkspaceRegistry(db, { configPath: join(home, "workspaces.json") });

  // Reopen previously-registered folders, then add the one passed on the CLI.
  await registry.load();
  let opened: { owner: string; repo: string } | null = null;
  if (dirArg !== undefined) {
    const dir = resolve(dirArg);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`not a directory: ${dir}`);
      process.exit(1);
    }
    const entry = await registry.addFolder(dir);
    opened = { owner: entry.identity.owner, repo: entry.identity.repo };
  }

  const app = createApp({ config, db, localRegistry: registry });

  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
    const root = `http://127.0.0.1:${info.port}/`;
    // Land on the opened workspace when a dir was passed, else the switcher.
    const url = opened ? `${root}${opened.owner}/${opened.repo}` : root;
    console.log(`\n  Cosheaf Workbench`);
    console.log(`  data:      ${home}`);
    const list = registry.list();
    if (list.length === 0) {
      console.log(`  workspaces: none yet — add a folder from the home page`);
    } else {
      console.log(`  workspaces:`);
      for (const e of list) {
        const remote = e.gitRemote ? `${e.gitRemote.host}/${e.gitRemote.owner}/${e.gitRemote.repo}` : "local-only";
        console.log(`    - ${e.slug.padEnd(28)} ${remote}${e.identity.canOpenPull ? "  [open-PR]" : ""}`);
      }
    }
    console.log(`\n  → ${url}\n`);
    if (process.env.COSHEAF_NO_OPEN !== "1") openBrowser(url);
  });
}

const program = new Command();
program
  .name("cosheaf-workbench")
  .description("Open the Cosheaf Workbench. With no folder, reopens your registered workspaces; with a folder, also opens it.")
  .argument("[dir]", "folder to open as a workspace")
  .action((dir: string | undefined) => {
    void run(dir);
  });
program.parse();
