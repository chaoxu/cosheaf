#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoflatRef, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COFLAT_DIR = resolve(REPO_ROOT, "..", "coflat");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...options.env,
    },
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "pipe",
    encoding: "utf8",
    shell: false,
    env: process.env,
    ...options,
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function runFastGate(cwd = REPO_ROOT) {
  run("pnpm", ["check:types"], { cwd });
  run("pnpm", ["lint:errors"], { cwd });
  run("pnpm", ["lint:boundaries"], { cwd });
}

function ensureCoflatCommit(ref) {
  if (output("git", ["-C", COFLAT_DIR, "cat-file", "-t", ref]) !== "commit") {
    run("git", ["-C", COFLAT_DIR, "fetch", "origin", ref]);
  }
}

function runIsolatedGate() {
  ensureCoflatCommit(DEFAULT_COFLAT_REF);
  const tmp = mkdtempSync(path.join(tmpdir(), "cosheaf-pre-push-"));
  const cosheafWorktree = path.join(tmp, "cosheaf");
  const coflatWorktree = path.join(tmp, "coflat");
  try {
    run("git", ["worktree", "add", "--detach", cosheafWorktree, "HEAD"]);
    run("git", ["-C", COFLAT_DIR, "worktree", "add", "--detach", coflatWorktree, DEFAULT_COFLAT_REF]);
    run("pnpm", ["--dir", coflatWorktree, "install", "--frozen-lockfile"]);
    run("pnpm", ["--dir", coflatWorktree, "build"]);
    run("pnpm", ["--dir", cosheafWorktree, "install", "--frozen-lockfile", "--ignore-scripts"]);
    run("pnpm", ["--dir", cosheafWorktree, "rebuild", "better-sqlite3", "esbuild"]);
    runFastGate(cosheafWorktree);
  } finally {
    run("git", ["worktree", "remove", "--force", cosheafWorktree], { allowFailure: true });
    run("git", ["-C", COFLAT_DIR, "worktree", "remove", "--force", coflatWorktree], { allowFailure: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

const coflat = checkCoflatRef();
if (coflat.ok) {
  runFastGate();
} else {
  console.error(coflat.message);
  console.error("Running pre-push checks in an isolated pinned Coflat worktree.");
  runIsolatedGate();
}
