#!/usr/bin/env node

// Enforces the Workbench's hard boundary: the local-Workbench backend code is
// Forgejo-free. Nothing under server/local/** may name a forge — no `forgejo`,
// `fjUser`, or `forgejoToken`. The local backend talks to the working tree and,
// at Tier 2, to a remote Cosheaf via its typed API; the forge is the remote's
// implementation detail, invisible here.
//
// Mirrors scripts/check-bare-catch.mjs. Run via `pnpm check:no-forgejo-workbench`
// (wired into check:lint).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const FORBIDDEN = /forgejo|fjUser|forgejoToken/i;
// The directory the boundary covers.
const SCAN_DIR = path.join("server", "local");

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function walk(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  return files.sort();
}

export function findForgeReferences(filePath, sourceText) {
  const violations = [];
  const lines = sourceText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(FORBIDDEN);
    if (match) violations.push({ filePath, line: i + 1, text: match[0] });
  }
  return violations;
}

function collectViolations(repoRoot) {
  const root = path.join(repoRoot, SCAN_DIR);
  return walk(root).flatMap((filePath) =>
    findForgeReferences(filePath, fs.readFileSync(filePath, "utf8")),
  );
}

export function main() {
  const repoRoot = process.cwd();
  const violations = collectViolations(repoRoot);
  if (violations.length === 0) return 0;

  console.error(
    `Forge reference(s) found under ${toPosix(SCAN_DIR)}/. The local Workbench must be Forgejo-free ` +
      `(no forgejo/fjUser/forgejoToken). Route remote operations through the typed Cosheaf API instead.`,
  );
  for (const v of violations) {
    console.error(`- ${toPosix(path.relative(repoRoot, v.filePath))}:${v.line}  (${v.text})`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exit(main());
}
