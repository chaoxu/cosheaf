#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblingRoot = resolve(repoRoot, "..", "coflat");
const siblingDist = resolve(siblingRoot, "dist");
const installedDist = resolve(repoRoot, "node_modules", "@chaoxu", "coflat", "dist");
const COFLAT_SOURCE_DIRS = ["src", "styles"];
const COFLAT_SOURCE_FILES = [
  "editor.ts",
  "reader.ts",
  "parse.ts",
  "latex.ts",
  "inline-render.ts",
  "rich-readonly.ts",
  "vite.editor.config.ts",
  "tsconfig.editor.json",
  "tsconfig.test-utils.json",
  "package.json",
  "pnpm-lock.yaml",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function files(dir) {
  if (!existsSync(dir)) fail(`missing Coflat dist: ${dir}. Run: pnpm refresh:coflat`);
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        out.push(relative(dir, path));
      }
    }
  }
  return out.sort();
}

function newestMtime(paths) {
  let newest = 0;
  let newestPath = null;
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!stat.isFile()) return;
    if (isCoflatTestFile(path)) return;
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
      newestPath = path;
    }
  };
  for (const path of paths) visit(path);
  return { mtimeMs: newest, path: newestPath };
}

function isCoflatTestFile(path) {
  return /\b(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function digest(dir, rels) {
  const hash = createHash("sha256");
  for (const rel of rels) {
    const path = join(dir, rel);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const siblingFiles = files(siblingDist);
const installedFiles = files(installedDist);
const siblingSource = newestMtime([
  ...COFLAT_SOURCE_DIRS.map((dir) => join(siblingRoot, dir)),
  ...COFLAT_SOURCE_FILES.map((file) => join(siblingRoot, file)),
]);
const siblingBuilt = newestMtime(siblingFiles.map((file) => join(siblingDist, file)));

if (siblingSource.path && siblingBuilt.path && siblingSource.mtimeMs > siblingBuilt.mtimeMs + 1000) {
  fail([
    "../coflat source is newer than ../coflat/dist, so Cosheaf would build against stale Coflat output.",
    `newest source: ${relative(siblingRoot, siblingSource.path)}`,
    `newest dist: ${relative(siblingRoot, siblingBuilt.path)}`,
    "Run: pnpm -C ../coflat build && pnpm refresh:coflat",
  ].join("\n"));
}

const siblingSet = new Set(siblingFiles);
const installedSet = new Set(installedFiles);
const missing = siblingFiles.filter((file) => !installedSet.has(file));
const extra = installedFiles.filter((file) => !siblingSet.has(file));

if (missing.length > 0 || extra.length > 0) {
  fail([
    "installed @chaoxu/coflat dist does not match ../coflat/dist.",
    missing.length > 0 ? `missing installed files: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}` : null,
    extra.length > 0 ? `extra installed files: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", ..." : ""}` : null,
    "Run: pnpm refresh:coflat",
  ].filter(Boolean).join("\n"));
}

const siblingHash = digest(siblingDist, siblingFiles);
const installedHash = digest(installedDist, siblingFiles);

if (!siblingHash || !installedHash || siblingHash !== installedHash) {
  fail([
    "installed @chaoxu/coflat dist is stale relative to ../coflat/dist.",
    `../coflat/dist: ${siblingHash ?? "<missing>"}`,
    `node_modules/@chaoxu/coflat/dist: ${installedHash ?? "<missing>"}`,
    "Run: pnpm refresh:coflat",
  ].join("\n"));
}
