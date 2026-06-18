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
export const DEFAULT_COFLAT_REF = "07cf322d9be0f20b7645aa1c05a66b56bd6b4d5d";

// Files that pin the Coflat SHA. Keep these in sync with bump-coflat.mjs.
export const DOC_PIN_FILES = ["README.md", "AGENTS.md"];
export const CONFIG_PIN_FILES = ["Dockerfile", "compose.yaml", ".github/workflows/ci.yml", ".gitea/workflows/ci.yml"];

function envCoflatRef(env = process.env) {
  const ref = env.COFLAT_REF?.trim();
  return ref || DEFAULT_COFLAT_REF;
}

function pinnedCoflatRef(rel, text) {
  const patterns = rel === "Dockerfile"
    ? [/ARG COFLAT_GIT_REF=([^\s]+)/]
    : rel === "compose.yaml"
      ? [/COFLAT_GIT_REF:\s*\$\{COFLAT_GIT_REF:-([^}]+)\}/]
      : rel === ".github/workflows/ci.yml" || rel === ".gitea/workflows/ci.yml"
        ? [/COFLAT_REF:\s*([^\s]+)/]
        : [/coflat checkout ([^\s]+)/];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function checkCoflatRef({
  coflatDir = resolve(REPO_ROOT, "..", "coflat"),
  expectedRef = envCoflatRef(),
  execFile = execFileSync,
} = {}) {
  if (!existsSync(coflatDir)) {
    return {
      ok: false,
      message: `missing sibling Coflat checkout: ${coflatDir}`,
    };
  }

  let actualRef = "";
  try {
    actualRef = execFile("git", ["-C", coflatDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (err) {
    return {
      ok: false,
      message: `could not read Coflat git revision at ${coflatDir}: ${err.message}`,
    };
  }

  if (actualRef !== expectedRef) {
    return {
      ok: false,
      message: `Coflat checkout is ${actualRef}, expected ${expectedRef}. Run: git -C ${coflatDir} fetch origin ${expectedRef} && git -C ${coflatDir} checkout ${expectedRef}`,
    };
  }

  return { ok: true, actualRef };
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
    const found = pinnedCoflatRef(rel, text);
    if (!found || (CONFIG_PIN_FILES.includes(rel) && !/^[0-9a-f]{40}$/.test(found))) {
      drifted.push({ file: rel, found: found ?? "<missing>" });
    } else if (found && found !== expectedRef) {
      drifted.push({ file: rel, found });
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
