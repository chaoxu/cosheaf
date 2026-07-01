#!/usr/bin/env node
// Standard consumer-side Workbench deploy. Run on a target machine (e.g. earth)
// to follow the latest bundle saturn published with `pnpm workbench:release`:
//
//   1. resolve the newest `workbench-*` release on the Gitea repo,
//   2. download its `cosheaf-workbench.tar.gz` asset,
//   3. atomically swap it into the install dir (keeping one backup),
//   4. restart the daemon.
//
//   node scripts/update-workbench.mjs                 # install to ~/cosheaf-workbench
//   node scripts/update-workbench.mjs --dir ~/wb      # custom install dir
//   node scripts/update-workbench.mjs --dry-run       # resolve + download, no swap
//   node scripts/update-workbench.mjs --restart "launchctl kickstart -k gui/$(id -u)/com.chaoxu.cosheaf-workbench"
//
// Auth: public releases need no token; otherwise set COSHEAF_GITEA_TOKEN.
import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";
import { run } from "./lib/run.mjs";

const program = new Command();
program
  .name("update-workbench")
  .description("Fetch the latest published Cosheaf Workbench bundle and swap it in")
  .option("--base <url>", "Gitea base URL", process.env.COSHEAF_GITEA_URL ?? "http://gitea.lab")
  .option("--repo <owner/repo>", "Gitea repo slug", "chaoxu/cosheaf")
  .option("--dir <path>", "install directory", join(homedir(), "cosheaf-workbench"))
  .option("--restart <cmd>", "shell command to restart the daemon after swap")
  .option("--dry-run", "resolve + download only; don't swap or restart")
  .parse(process.argv.filter((a, i) => !(i >= 2 && a === "--")));
const opts = program.opts();

const headers = process.env.COSHEAF_GITEA_TOKEN
  ? { Authorization: `token ${process.env.COSHEAF_GITEA_TOKEN}` }
  : {};

async function api(path) {
  const res = await fetch(`${opts.base}/api/v1/repos/${opts.repo}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

// Newest `workbench-*` release (releases are returned newest-first).
const releases = await api("/releases?limit=50");
const release = releases.find((r) => typeof r.tag_name === "string" && r.tag_name.startsWith("workbench-"));
if (!release) throw new Error(`no workbench-* release found on ${opts.repo}`);
const asset = (release.assets ?? []).find((a) => a.name === "cosheaf-workbench.tar.gz");
if (!asset) throw new Error(`release ${release.tag_name} has no cosheaf-workbench.tar.gz asset`);
console.log(`latest bundle: ${release.tag_name}`);

// Stage on the same filesystem as the install dir so the final swap is an
// intra-filesystem rename. os.tmpdir() is frequently a separate mount (tmpfs
// /tmp on Linux consumers); a cross-device renameSync throws EXDEV mid-swap,
// after the old install has already been moved aside — destroying the install.
const dir = opts.dir;
const work = mkdtempSync(join(dirname(dir), ".cosheaf-wb-"));
const tarPath = join(work, "bundle.tar.gz");
const dl = await fetch(asset.browser_download_url, { headers });
if (!dl.ok || !dl.body) {
  rmSync(work, { recursive: true, force: true });
  throw new Error(`download failed → ${dl.status}`);
}
await pipeline(Readable.fromWeb(dl.body), createWriteStream(tarPath));

const staged = join(work, "extracted");
mkdirSync(staged);
run("tar", ["-xzf", tarPath, "-C", staged]);
// pack-workbench.mjs always archives a single top-level `dist-workbench/` folder.
const bundleRoot = join(staged, "dist-workbench");
if (!existsSync(join(bundleRoot, "cosheaf-workbench"))) {
  rmSync(work, { recursive: true, force: true });
  throw new Error("bundle is missing the cosheaf-workbench run shim — wrong asset?");
}

if (opts.dryRun) {
  console.log(`dry run: ${release.tag_name} downloaded and validated (shim present); not swapped`);
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

// Swap the new bundle into place with an intra-filesystem rename, keeping one .bak.
const backup = `${dir}.bak`;
if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
if (existsSync(dir)) renameSync(dir, backup);
renameSync(bundleRoot, dir);
rmSync(work, { recursive: true, force: true });
console.log(`installed ${release.tag_name} → ${dir} (previous kept at ${backup})`);

const restart = opts.restart ?? process.env.COSHEAF_WORKBENCH_RESTART;
if (restart) {
  console.log(`$ ${restart}`);
  execSync(restart, { stdio: "inherit" });
} else {
  console.log("no --restart given; restart the workbench daemon to pick up the new bundle.");
}
