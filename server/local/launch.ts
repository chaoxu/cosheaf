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

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Command } from "commander";
import open from "open";
import { createApp } from "../app.js";
import { resolveAppRoot } from "../app-root.js";
import { buildLocalConfig, getDb } from "../db.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function openBrowser(url: string): void {
  // `open` handles macOS/Windows/Linux/WSL; best-effort (headless is fine).
  void open(url).catch(() => undefined);
}

// Resolve the listen port: --port, else COSHEAF_PORT, else 0 (a random free
// port). A fixed port gives a stable URL to bookmark or SSH-forward; the bind
// stays loopback either way (the Workbench has no auth — see the serve() host).
function resolvePort(raw: string | undefined): number {
  const value = raw ?? process.env.COSHEAF_PORT;
  if (value === undefined || value.trim() === "") return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`invalid port: ${value} (expected 0-65535)`);
    process.exit(1);
  }
  return n;
}

async function run(dirArg: string | undefined, opts: { port?: string }): Promise<void> {
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
  const config = buildLocalConfig({ dataDir: home, port: resolvePort(opts.port) });
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

  // Loopback HTTP/1.1, no TLS — the right call for a single-user local tool:
  // loopback can't be eavesdropped and `localhost` is already a secure context,
  // so TLS would only add cert/trust friction. HTTP/2 would need that cert for no
  // real gain on loopback. The one HTTP/1.1 caveat (~6 connections/origin) only
  // bites when connections are pinned, so local mode keeps no idle long-lived
  // connections (no notification SSE — see app.ts) and SSE handlers release on
  // disconnect (see streamHubChannel), not on a timer.
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
    const root = `http://127.0.0.1:${info.port}/`;
    // Land on the opened workspace when a dir was passed, else the switcher.
    const url = opened ? `${root}${opened.owner}/${opened.repo}` : root;
    console.log(`\n  Cosheaf Workbench`);
    console.log(`  data:      ${home}`);
    console.log(`  logs:      ${join(home, "server.log")}`);
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
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n  port ${config.port} is already in use — choose another with --port <n> or COSHEAF_PORT.\n`);
      process.exit(1);
    }
    throw err;
  });
}

const program = new Command();
program
  .name("cosheaf-workbench")
  .description("Open the Cosheaf Workbench. With no folder, reopens your registered workspaces; with a folder, also opens it.")
  .argument("[dir]", "folder to open as a workspace")
  .option("-p, --port <port>", "loopback port to listen on (default: a random free port; or COSHEAF_PORT)")
  .action((dir: string | undefined, opts: { port?: string }) => {
    void run(dir, opts);
  });
program.parse();
