#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchor every default path to this script's location (<repo>/scripts/), not the
// process cwd: the doc-pin gate and sibling-checkout check must agree on where
// the repo root is even when invoked from a subdirectory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Single source of truth for the pinned sibling-Coflat revision. The setup
// docs (README, AGENTS) must agree with this; `checkDocPins` enforces it so a
// `bump:coflat` that misses a doc site is caught by setup:deps, not by a
// developer following a stale README into a failing checkout.
export const DEFAULT_COFLAT_REF = "ebb042992c8d5849da61205dbbc52158a800b863";

// Files that pin the Coflat SHA. Keep these in sync with bump-coflat.mjs.
export const DOC_PIN_FILES = ["README.md", "AGENTS.md"];
export const CONFIG_PIN_FILES = ["Dockerfile", "compose.yaml", ".github/workflows/ci.yml", ".gitea/workflows/ci.yml"];

function envCoflatRef(env = process.env) {
  const ref = env.COFLAT_REF?.trim();
  return ref || DEFAULT_COFLAT_REF;
}

function nestedGitEnv(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.startsWith("GIT_")) delete next[key];
  }
  return next;
}

function pinnedCoflatRefs(rel, text) {
  const patterns = rel === "Dockerfile"
    ? [/ARG COFLAT_GIT_REF=(?!unknown\b)([^\s]+)/g]
    : rel === "compose.yaml"
      ? [/COFLAT_GIT_REF:\s*\$\{COFLAT_GIT_REF:-([^}]+)\}/g]
      : rel === ".github/workflows/ci.yml" || rel === ".gitea/workflows/ci.yml"
        ? [/COFLAT_REF:\s*([^\s]+)/g]
        : [/coflat checkout ([^\s]+)/g];
  const refs = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) refs.push(match[1]);
    }
  }
  return refs;
}

export function checkCoflatRef({
  coflatDir = resolve(REPO_ROOT, "..", "coflat"),
  expectedRef = envCoflatRef(),
  execFile = execFileSync,
  env = process.env,
} = {}) {
  if (!existsSync(coflatDir)) {
    return {
      ok: false,
      message: `missing sibling Coflat checkout: ${coflatDir}`,
    };
  }

  let actualRef = "";
  try {
    actualRef = execFile("git", ["-C", coflatDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: nestedGitEnv(env),
    }).trim();
  } catch (err) {
    return {
      ok: false,
      message: `could not read Coflat git revision at ${coflatDir}: ${err.message}`,
    };
  }

  if (actualRef !== expectedRef) {
    let dirty = false;
    try {
      dirty = execFile("git", ["-C", coflatDir, "status", "--porcelain"], {
        encoding: "utf8",
        env: nestedGitEnv(env),
      }).trim().length > 0;
    } catch (_err) {
      // The revision read already proved this is a Git checkout; if status cannot
      // be read, keep the older actionable message.
    }
    const switchCommand = `git -C ${coflatDir} fetch origin ${expectedRef} && git -C ${coflatDir} checkout ${expectedRef}`;
    return {
      ok: false,
      expectedRef,
      message: dirty
        ? `Coflat checkout is ${actualRef}, expected ${expectedRef}, and ${coflatDir} has local changes. Do not switch it in place unless that work is saved. For an isolated pinned check, run: pnpm check:pre-push. To fix a clean checkout, run: ${switchCommand}`
        : `Coflat checkout is ${actualRef}, expected ${expectedRef}. Run: ${switchCommand}`,
    };
  }

  return { ok: true, actualRef, expectedRef };
}

// Returns the doc files whose pinned coflat SHA disagrees with `expectedRef`.
// CLAUDE.md is a symlink to AGENTS.md, so scanning AGENTS.md covers both.
export function checkDocPins({
  repoRoot = REPO_ROOT,
  expectedRef = DEFAULT_COFLAT_REF,
  files = [...DOC_PIN_FILES, ...CONFIG_PIN_FILES],
  readFile = (p) => readFileSync(p, "utf8"),
} = {}) {
  const drifted = [];
  for (const rel of files) {
    let text;
    try {
      text = readFile(resolve(repoRoot, rel));
    } catch (_err) {
      // Missing doc (e.g. a partial checkout) is not a drift; skip it.
      continue;
    }
    const found = pinnedCoflatRefs(rel, text);
    const invalid = CONFIG_PIN_FILES.includes(rel)
      ? found.find((ref) => !/^[0-9a-f]{40}$/.test(ref))
      : null;
    const mismatch = found.find((ref) => ref !== expectedRef);
    if (found.length === 0 || invalid) {
      drifted.push({ file: rel, found: invalid ?? "<missing>" });
    } else if (mismatch) {
      drifted.push({ file: rel, found: mismatch });
    }
  }
  return drifted;
}

export function main() {
  const result = checkCoflatRef();
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  const drifted = checkDocPins();
  if (drifted.length > 0) {
    for (const d of drifted) {
      console.error(`Coflat pin drift: ${d.file} pins ${d.found}, expected ${DEFAULT_COFLAT_REF}. Run: pnpm bump:coflat ${DEFAULT_COFLAT_REF}`);
    }
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--print")) {
    process.stdout.write(`${DEFAULT_COFLAT_REF}\n`);
  } else if (process.argv.includes("--warn")) {
    // Non-blocking notice (dev startup / pre-push): report drift, never fail.
    const code = main();
    if (code !== 0) console.error("(coflat pin warning — non-blocking)");
    process.exitCode = 0;
  } else {
    process.exitCode = main();
  }
}
