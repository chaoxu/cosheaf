#!/usr/bin/env node
// Pack the local Workbench into a self-contained, plain-Node distributable.
//
// Produces dist-workbench/ (and cosheaf-workbench.tar.gz) that runs on another
// same-arch machine with only `node` — no repo, no pnpm, no sibling ../coflat,
// no build step. Mirrors the prod Dockerfile's prod-deps recipe (a sibling
// cosheaf/coflat layout + `pnpm install --prod` + `rebuild better-sqlite3`,
// with package-import-method=copy so node_modules is portable) but assembles a
// tarball instead of a container.
//
// Bundle layout:
//   dist-workbench/
//     cosheaf-workbench        # shell shim: sets COSHEAF_APP_ROOT, exec node …
//     dist-server/             # compiled server (entry: server/local/launch.js)
//     dist/  public/           # built islands + manifest + server-rendered assets
//     vendor/coflat/           # vendored coflat dist (reader/editor/css/fonts)
//     node_modules/            # prod deps only, incl. better-sqlite3's .node
//     package.json  README.md
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const COFLAT_PIN = "98eb78f62e99354ab326be7a7132fe953425d8b6";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coflatSrc = resolve(repoRoot, "..", "coflat");
const outDir = join(repoRoot, "dist-workbench");
const tarball = join(repoRoot, "cosheaf-workbench.tar.gz");

const program = new Command();
program
  .name("pack-workbench")
  .description("Pack the local Workbench into a self-contained plain-Node distributable")
  .option("--skip-build", "reuse existing dist/ and dist-server/ instead of rebuilding")
  .option("--no-tarball", "leave dist-workbench/ unpacked; skip the .tar.gz")
  // `pnpm workbench:pack -- --skip-build` forwards a lone `--`; drop it so it is
  // not parsed as an unexpected operand.
  .parse(process.argv.filter((a, i) => !(i >= 2 && a === "--")));
const opts = program.opts();

function run(cmd, args, cwd = repoRoot) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function step(msg) {
  console.log(`\n=== ${msg} ===`);
}

if (!existsSync(join(coflatSrc, "dist", "editor.css"))) {
  console.error(`coflat dist not found at ${coflatSrc}/dist — build the pinned ../coflat first (pin ${COFLAT_PIN}).`);
  process.exit(1);
}

// 1. Build the islands (dist/) and the server (dist-server/).
if (opts.skipBuild) {
  if (!existsSync(join(repoRoot, "dist", ".vite", "manifest.json")) || !existsSync(join(repoRoot, "dist-server"))) {
    console.error("--skip-build set but dist/.vite/manifest.json or dist-server/ is missing — run a full pack once.");
    process.exit(1);
  }
  step("Reusing existing dist/ and dist-server/ (--skip-build)");
} else {
  step("Build islands (vite) and server (tsc)");
  run("pnpm", ["build"]);
  run("pnpm", ["build:server"]);
}

// 2. Prod node_modules via a sibling cosheaf/coflat temp install (Dockerfile recipe).
step("Resolve portable prod node_modules");
const stage = mkdtempSync(join(tmpdir(), "cosheaf-pack-"));
const stageCosheaf = join(stage, "cosheaf");
const stageCoflat = join(stage, "coflat");
mkdirSync(stageCosheaf, { recursive: true });
mkdirSync(stageCoflat, { recursive: true });
// coflat resolves from file:../coflat — supply just what the file: dep needs.
cpSync(join(coflatSrc, "package.json"), join(stageCoflat, "package.json"));
cpSync(join(coflatSrc, "dist"), join(stageCoflat, "dist"), { recursive: true });
if (existsSync(join(coflatSrc, "patches"))) cpSync(join(coflatSrc, "patches"), join(stageCoflat, "patches"), { recursive: true });
cpSync(join(repoRoot, "package.json"), join(stageCosheaf, "package.json"));
cpSync(join(repoRoot, "pnpm-lock.yaml"), join(stageCosheaf, "pnpm-lock.yaml"));
// node-linker=hoisted → a flat node_modules of real directories (npm-style, no
// .pnpm symlink indirection); package-import-method=copy → real files, not
// hardlinks into the global store. Together these make node_modules fully
// relocatable to a fresh machine. file:../coflat is copied in as real files.
run(
  "pnpm",
  [
    "install",
    "--prod",
    "--ignore-scripts",
    "--config.node-linker=hoisted",
    "--config.package-import-method=copy",
  ],
  stageCosheaf,
);

// 3. Assemble the bundle directory.
step("Assemble dist-workbench/");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(stageCosheaf, "node_modules"), join(outDir, "node_modules"), { recursive: true, dereference: false });
// .bin holds CLI shims that symlink into the (now-deleted) temp stage. They are
// build-tooling, never imported at runtime — drop them so the bundle has no
// dangling symlinks.
rmSync(join(outDir, "node_modules", ".bin"), { recursive: true, force: true });
// Build better-sqlite3's native addon in place, in the bundle, so the .node
// lands at the build/Release path bindings.js looks for. (Done here, not in the
// stage, because pnpm's hoisted-layout rebuild left no addon.) Matches the
// running Node ABI; the bundle is arch- and Node-major-bound by design.
step("Build better-sqlite3 native addon in the bundle");
run("npm", ["rebuild", "better-sqlite3"], outDir);
cpSync(join(repoRoot, "dist"), join(outDir, "dist"), { recursive: true });
cpSync(join(repoRoot, "public"), join(outDir, "public"), { recursive: true });
cpSync(join(repoRoot, "dist-server"), join(outDir, "dist-server"), { recursive: true });
cpSync(join(repoRoot, "package.json"), join(outDir, "package.json"));
// Vendor coflat dist so assets resolve via COSHEAF_APP_ROOT even if node_modules
// coflat is ever unavailable (resolveCoflatDistDir prefers vendor/coflat).
cpSync(join(coflatSrc, "dist"), join(outDir, "vendor", "coflat"), { recursive: true });

// 4. Launcher shim + consumer README.
const shim = `#!/bin/sh
# Cosheaf Workbench — open a local folder in the rich Coflat editor/reader.
# Usage: ./cosheaf-workbench /path/to/folder
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export COSHEAF_APP_ROOT="$HERE"
# Tier-2 push/PR against an internal-CA host (e.g. https://cosheaf-test.lab):
# trust an extra CA bundle when COSHEAF_CA_FILE is set. NODE_EXTRA_CA_CERTS must
# be exported before node starts, which is why this lives in the shim.
if [ -n "\${COSHEAF_CA_FILE:-}" ] && [ -z "\${NODE_EXTRA_CA_CERTS:-}" ]; then
  export NODE_EXTRA_CA_CERTS="\$COSHEAF_CA_FILE"
fi
exec node "$HERE/dist-server/server/local/launch.js" "$@"
`;
writeFileSync(join(outDir, "cosheaf-workbench"), shim);
chmodSync(join(outDir, "cosheaf-workbench"), 0o755);

const readme = `# Cosheaf Workbench (bundle)

Self-contained local editor for Coflat/Markdown folders. Needs only \`node\` —
no repo, no pnpm, no build step.

## Run

    ./cosheaf-workbench /path/to/your/folder

Opens a loopback server and your browser. Edits save to disk; commit and (with a
configured remote) open-PR are explicit actions in the UI.

## Tiers

- Any folder: rich edit + read, save to disk, offline search/backlinks.
- Git repo: branch/status display + explicit Commit.
- Remote + Cosheaf token (in \`<folder>/.cosheaf/remote.json\`, gitignored):
  \`git push\` over your SSH key + open PR via the remote Cosheaf API.

## Reaching an internal-CA host (e.g. cosheaf-test.lab) over HTTPS

Node rejects the lab Caddy root by default. Point it at the CA bundle:

    COSHEAF_CA_FILE=~/.cosheaf/lab-root.pem ./cosheaf-workbench /path/to/folder

(or set \`NODE_EXTRA_CA_CERTS\` yourself). The plain-HTTP tailnet endpoint needs
no CA.

Coflat pin: ${COFLAT_PIN}
`;
writeFileSync(join(outDir, "README.md"), readme);

// 5. Tarball.
if (opts.tarball) {
  step("Create cosheaf-workbench.tar.gz");
  rmSync(tarball, { force: true });
  run("tar", ["-czf", tarball, "-C", repoRoot, "dist-workbench"]);
}

rmSync(stage, { recursive: true, force: true });

const sizeMB = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
step("Done");
console.log(`bundle:  ${outDir}`);
if (opts.tarball) console.log(`tarball: ${tarball} (${sizeMB(tarball)} MB)`);
console.log(`run:     ${join(outDir, "cosheaf-workbench")} /path/to/folder`);
