#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function usage() {
  console.error("usage: node scripts/jupiter-preview.mjs <url|list|clean> [branch] [--keep-volume]");
  process.exit(2);
}

const [action, branch, flag] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!action) usage();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  return options.capture ? result.stdout.trim() : "";
}

function slugForBranch(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "branch";
}

function previewFor(name) {
  const slug = slugForBranch(name);
  return {
    slug,
    url: `https://cosheaf-${slug}.lab`,
    container: `cosheaf-preview-${slug}`,
    volume: `cosheaf-preview-${slug}-data`,
    image: `cosheaf-preview:${slug}`,
    caddy: `/etc/caddy/sites.d/cosheaf-preview-${slug}.caddy`,
  };
}

if (action === "url") {
  if (!branch) usage();
  const p = previewFor(branch);
  console.log(p.url);
  console.log(`container=${p.container}`);
  console.log(`volume=${p.volume}`);
  console.log(`caddy=${p.caddy}`);
} else if (action === "list") {
  run("docker", ["ps", "-a", "--filter", "name=cosheaf-preview-", "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"]);
} else if (action === "clean") {
  if (!branch) usage();
  const p = previewFor(branch);
  run("docker", ["rm", "-f", p.container], { allowFailure: true });
  run("docker", ["image", "rm", p.image], { allowFailure: true });
  run("sudo", ["-n", "rm", "-f", p.caddy], { allowFailure: true });
  run("sudo", ["-n", "/usr/bin/systemctl", "reload", "caddy"]);
  if (flag !== "--keep-volume") run("docker", ["volume", "rm", p.volume], { allowFailure: true });
  console.log(`removed ${p.url}`);
} else {
  usage();
}
