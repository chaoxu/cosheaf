#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { output, run, tryOutput } from "./lib/run.mjs";
import { slugForBranch } from "./preview-state.mjs";

const JUPITER_HOST = process.env.COSHEAF_JUPITER_HOST ?? "jupiter";
const PORTS = { start: 3100, end: 3199 };

function currentBranch() {
  return output("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function currentSha() {
  return output("git", ["rev-parse", "HEAD"]);
}

function currentRemote() {
  return tryOutput("git", ["config", "--get", "remote.origin.url"]) || "unknown";
}

function hostIdentity() {
  try {
    return readFileSync("/etc/lab-host", "utf8").trim();
  } catch (_error) {
    return "unknown";
  }
}

function previewFor(name) {
  const slug = slugForBranch(name);
  return {
    slug,
    url: `https://cosheaf-${slug}.lab`,
    directUrl: null,
    container: `cosheaf-preview-${slug}`,
    volume: `cosheaf-preview-${slug}-data`,
    image: `cosheaf-preview:${slug}`,
    caddy: `/etc/caddy/sites.d/cosheaf-preview-${slug}.caddy`,
  };
}

function waitForHttps(url) {
  for (let i = 1; i <= 90; i += 1) {
    const result = spawnSync("curl", ["-sf", `${url}/api/v1/health`], {
      stdio: "ignore",
      shell: false,
    });
    if (result.status === 0) {
      console.log(`https ready after ${i}s`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  console.error(`warning: ${url} did not pass local HTTPS health within 90s`);
}

function deploy(branch) {
  const sha = currentSha();
  const remote = currentRemote();
  const p = previewFor(branch);
  const work = mkdtempSync(path.join(tmpdir(), "cosheaf-preview-"));
  const archive = path.join(work, `${p.slug}.tar`);
  try {
    run("git", ["archive", "--format=tar", "-o", archive, "HEAD"]);
    if (hostIdentity() === "jupiter") {
      run("cp", [archive, `/tmp/cosheaf-preview-${p.slug}.tar`]);
      run("bash", [
        new URL("./jupiter-preview-host.sh", import.meta.url).pathname,
        "deploy-local",
        branch,
        sha,
        p.slug,
        remote,
        `${PORTS.start}`,
        `${PORTS.end}`,
      ]);
    } else {
      run("scp", [archive, `${JUPITER_HOST}:/tmp/cosheaf-preview-${p.slug}.tar`]);
      run("ssh", [
        JUPITER_HOST,
        "bash",
        "-s",
        "--",
        "deploy-local",
        branch,
        sha,
        p.slug,
        remote,
        `${PORTS.start}`,
        `${PORTS.end}`,
      ], {
        input: readFileSync(new URL("./jupiter-preview-host.sh", import.meta.url)),
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  waitForHttps(p.url);
  console.log("");
  console.log(p.url);
  console.log(`container=${p.container}`);
  console.log(`volume=${p.volume}`);
  console.log(`caddy=${p.caddy}`);
  console.log(`cleanup=pnpm jupiter:preview -- clean ${branch}`);
}

function remote(actionName, branch, keepVolume) {
  const args = ["bash", "-s", "--", actionName, branch ?? "", "", slugForBranch(branch ?? ""), "unknown", `${PORTS.start}`, `${PORTS.end}`];
  if (keepVolume) args.push("--keep-volume");
  run("ssh", [JUPITER_HOST, ...args], {
    input: readFileSync(new URL("./jupiter-preview-host.sh", import.meta.url)),
  });
}

const program = new Command("jupiter-preview");

program
  .command("deploy [branch]")
  .description("deploy a branch preview to jupiter")
  .action((branch) => deploy(branch ?? currentBranch()));

program
  .command("url <branch>")
  .description("print the preview URL and resource names for a branch")
  .action((branch) => {
    const p = previewFor(branch);
    console.log(p.url);
    console.log(`container=${p.container}`);
    console.log(`volume=${p.volume}`);
    console.log(`caddy=${p.caddy}`);
  });

program
  .command("list")
  .description("list jupiter preview containers")
  .action(() => {
    if (hostIdentity() === "jupiter") {
      run("bash", [new URL("./jupiter-preview-host.sh", import.meta.url).pathname, "list-local", "", "", "", "unknown", `${PORTS.start}`, `${PORTS.end}`]);
    } else {
      remote("list-local");
    }
  });

program
  .command("clean <branch>")
  .description("remove a branch preview from jupiter")
  .option("--keep-volume", "keep the preview data volume", false)
  .action((branch, opts) => {
    if (hostIdentity() === "jupiter" && existsSync("/usr/bin/docker")) {
      run("bash", [
        new URL("./jupiter-preview-host.sh", import.meta.url).pathname,
        "clean-local",
        branch,
        "",
        slugForBranch(branch),
        "unknown",
        `${PORTS.start}`,
        `${PORTS.end}`,
        opts.keepVolume ? "--keep-volume" : "",
      ]);
    } else {
      remote("clean-local", branch, opts.keepVolume);
    }
  });

program.parse(process.argv);
