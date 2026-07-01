#!/usr/bin/env node
// Publish the packed Workbench tarball as a release asset (defaults to GitHub, supports Gitea)
// so a consumer (e.g. earth) can fetch the latest build. Builds the bundle first unless --skip-pack.
//
//   node scripts/release-workbench.mjs                 # tag workbench-<YYYYMMDD-HHMM>
//   node scripts/release-workbench.mjs --tag wb-1      # explicit tag
//   node scripts/release-workbench.mjs --gitea         # release to Gitea instead of GitHub
//   node scripts/release-workbench.mjs --skip-pack     # reuse cosheaf-workbench.tar.gz
import { execFileSync } from "node:child_process";
import fs, { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { argvWithoutForwardedDashDash } from "./lib/argv.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = join(repoRoot, "cosheaf-workbench.tar.gz");

const program = new Command();
program
  .name("release-workbench")
  .description("Publish the packed Workbench tarball as a release asset")
  .option("--tag <tag>", "release tag (default: workbench-<timestamp>)")
  .option("--repo <owner/repo>", "repo slug", "chaoxu/cosheaf")
  .option("--gitea", "release to Gitea instead of GitHub")
  .option("--login <login>", "tea login to use (Gitea only)", "coflat")
  .option("--skip-pack", "reuse the existing cosheaf-workbench.tar.gz instead of repacking")
  .parse(argvWithoutForwardedDashDash());
const opts = program.opts();

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

if (!opts.skipPack) run("node", ["scripts/pack-workbench.mjs"]);
if (!existsSync(tarball)) {
  console.error(`tarball not found: ${tarball} — run without --skip-pack, or pnpm workbench:pack first.`);
  process.exit(1);
}

// Timestamp tag — pass an absolute clock value (scripts run with a real clock)
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
const tag = opts.tag ?? `workbench-${stamp}`;
const sizeMB = (statSync(tarball).size / 1024 / 1024).toFixed(1);
const title = `Cosheaf Workbench ${tag}`;
const note = `Self-contained Workbench bundle (${sizeMB} MB). Untar and run ./cosheaf-workbench <folder>. Requires Node on the target (same major as built) and matching CPU arch (Apple Silicon).`;

async function releaseToGithub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is required to release to GitHub.");
    process.exit(1);
  }

  const userAgent = "cosheaf-workbench-release";
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent,
    "Content-Type": "application/json",
  };

  console.log(`Creating GitHub release ${tag}...`);
  const createRes = await fetch(`https://api.github.com/repos/${opts.repo}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tag_name: tag,
      name: title,
      body: note,
      draft: false,
      prerelease: false,
    }),
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    throw new Error(`Failed to create release: HTTP ${createRes.status} - ${errorText}`);
  }

  const releaseData = await createRes.json();
  const rawUploadUrl = releaseData.upload_url;
  const uploadUrl = rawUploadUrl.replace(/\{.*?\}/, "") + "?name=cosheaf-workbench.tar.gz";

  console.log(`Uploading asset to GitHub: ${uploadUrl}`);
  const fileBuffer = fs.readFileSync(tarball);
  const uploadHeaders = {
    "Authorization": `Bearer ${token}`,
    "User-Agent": userAgent,
    "Content-Type": "application/octet-stream",
    "Content-Length": fileBuffer.length.toString(),
  };

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: uploadHeaders,
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text();
    throw new Error(`Failed to upload asset: HTTP ${uploadRes.status} - ${errorText}`);
  }

  console.log(`Successfully uploaded asset to GitHub release ${tag}.`);
}

if (opts.gitea) {
  run("tea", [
    "releases",
    "create",
    "--repo",
    opts.repo,
    "--login",
    opts.login,
    "--tag",
    tag,
    "--title",
    title,
    "--note",
    note,
    "--asset",
    tarball,
  ]);
  console.log(`\nPublished ${tag} with cosheaf-workbench.tar.gz (${sizeMB} MB) to Gitea ${opts.repo}.`);
} else {
  await releaseToGithub();
  console.log(`\nPublished ${tag} with cosheaf-workbench.tar.gz (${sizeMB} MB) to GitHub ${opts.repo}.`);
}
