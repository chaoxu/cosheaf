import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoflatRef, DEFAULT_COFLAT_REF } from "../check-coflat-ref.mjs";
import { output, run } from "./run.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COFLAT_DIR = resolve(REPO_ROOT, "..", "coflat");

export async function runFastGate(cwd = REPO_ROOT) {
  await runParallel([
    ["pnpm", ["check:types"]],
    ["pnpm", ["lint:errors"]],
    ["pnpm", ["lint:boundaries"]],
  ], { cwd });
}

export async function runLocalGate(cwd = REPO_ROOT) {
  await runParallel([
    ["pnpm", ["check:lint"]],
    ["pnpm", ["check:types"]],
    ["pnpm", ["check:unused"]],
    ["pnpm", ["test"]],
  ], { cwd });
  await runParallel([
    ["pnpm", ["build"]],
    ["pnpm", ["build:server"]],
  ], { cwd });
}

export function ensureCoflatCommit(ref = DEFAULT_COFLAT_REF) {
  if (output("git", ["-C", COFLAT_DIR, "cat-file", "-t", ref], { allowFailure: true }) !== "commit") {
    run("git", ["-C", COFLAT_DIR, "fetch", "origin", ref]);
  }
}

export async function runIsolatedPinnedGate({
  source = "head",
  gate = runFastGate,
  label = "cosheaf-pinned",
  coflatRef = DEFAULT_COFLAT_REF,
} = {}) {
  ensureCoflatCommit(coflatRef);
  const tmp = mkdtempSync(path.join(tmpdir(), `${label}-`));
  const cosheafWorktree = path.join(tmp, "cosheaf");
  const coflatWorktree = path.join(tmp, "coflat");
  try {
    if (source === "working-tree") copyWorkingTree(cosheafWorktree);
    else run("git", ["worktree", "add", "--detach", cosheafWorktree, "HEAD"]);
    run("git", ["-C", COFLAT_DIR, "worktree", "add", "--detach", coflatWorktree, coflatRef]);
    run("pnpm", ["--dir", coflatWorktree, "install", "--frozen-lockfile"]);
    run("pnpm", ["--dir", coflatWorktree, "build"]);
    run("pnpm", ["--dir", cosheafWorktree, "install", "--frozen-lockfile", "--ignore-scripts"]);
    run("pnpm", ["--dir", cosheafWorktree, "rebuild", "better-sqlite3", "esbuild"]);
    await gate(cosheafWorktree);
  } finally {
    if (source !== "working-tree") run("git", ["worktree", "remove", "--force", cosheafWorktree], { allowFailure: true });
    run("git", ["-C", COFLAT_DIR, "worktree", "remove", "--force", coflatWorktree], { allowFailure: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runWithPinnedFallback({
  gate = runFastGate,
  isolatedGate = gate,
  source = "head",
  fallbackMessage = "Running checks in an isolated pinned Coflat worktree.",
} = {}) {
  const coflat = checkCoflatRef();
  if (coflat.ok) {
    await gate(REPO_ROOT);
    return;
  }
  console.error(coflat.message);
  console.error(fallbackMessage);
  await runIsolatedPinnedGate({ source, gate: isolatedGate, coflatRef: coflat.expectedRef ?? DEFAULT_COFLAT_REF });
}

async function runParallel(commands, options = {}) {
  const failures = [];
  await Promise.all(commands.map(([command, args]) =>
    new Promise((resolvePromise) => {
      console.log(`$ ${[command, ...args].join(" ")}`);
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: "inherit",
        shell: false,
      });
      child.on("error", (error) => {
        failures.push({ command, args, code: 1, error });
        resolvePromise();
      });
      child.on("close", (code) => {
        if (code !== 0) failures.push({ command, args, code: code ?? 1 });
        resolvePromise();
      });
    }),
  ));
  if (failures.length === 0) return;
  for (const failure of failures) {
    const suffix = failure.error ? ` (${failure.error.message})` : "";
    console.error(`Command failed (${failure.code}): ${[failure.command, ...failure.args].join(" ")}${suffix}`);
  }
  process.exit(failures[0].code);
}

export function gitVisibleFiles(gitFn = (args) => output("git", args, { cwd: REPO_ROOT, allowFailure: true })) {
  const out = gitFn(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return out.split("\0").filter(Boolean);
}

export function copyWorkingTree(destination, files = gitVisibleFiles()) {
  for (const rel of files) {
    const source = path.join(REPO_ROOT, rel);
    if (!existsSync(source)) continue;
    const target = path.join(destination, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  }
}
