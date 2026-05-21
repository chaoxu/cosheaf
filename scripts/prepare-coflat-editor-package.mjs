#!/usr/bin/env node
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const editorDir = resolve(root, "..", "coflat-editor");
const vendorDir = resolve(root, "vendor");
const packageDir = resolve(vendorDir, "coflat-editor-package");
const pnpmVersion = "10.33.0";
process.env.PATH = `${resolve(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.error) {
    console.error(`${command} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return options.capture ? result.stdout.trim() : "";
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    shell: false,
  });
  return result.status === 0;
}

if (!commandExists("pnpm")) {
  run("npm", ["install", "-g", `pnpm@${pnpmVersion}`, "--prefix", resolve(homedir(), ".local")]);
}

mkdirSync(vendorDir, { recursive: true });
rmSync(packageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(packageDir, { recursive: true });

run("pnpm", ["--dir", editorDir, "install", "--frozen-lockfile"]);
const packOutput = run("pnpm", ["--dir", editorDir, "pack", "--pack-destination", vendorDir], { capture: true });
const tarball = packOutput
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .at(-1);

if (!tarball?.endsWith(".tgz")) {
  console.error(`could not find packed coflat-editor tarball in output:\n${packOutput}`);
  process.exit(1);
}

run("tar", ["-xzf", tarball, "-C", packageDir]);
rmSync(tarball, { force: true });
console.log(`prepared ${packageDir}/package`);
