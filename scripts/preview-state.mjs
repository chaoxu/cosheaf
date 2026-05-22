#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  console.error("usage: node scripts/preview-state.mjs <slug|read-port|allocate|delete-port> ...");
  process.exit(2);
}

function slugForBranch(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "branch";
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8") || "{}");
  } catch (_error) {
    return {};
  }
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action) usage();

  if (action === "slug") {
    const [branch] = args;
    if (!branch) usage();
    process.stdout.write(slugForBranch(branch));
  } else if (action === "read-port") {
    const [file, slug] = args;
    if (!file || !slug) usage();
    const data = readJson(file);
    process.stdout.write(data[slug] ? String(data[slug]) : "");
  } else if (action === "allocate") {
    const [file, slug, startRaw, endRaw, ...usedRaw] = args;
    if (!file || !slug || !startRaw || !endRaw) usage();
    const data = readJson(file);
    if (data[slug]) {
      process.stdout.write(String(data[slug]));
      process.exit(0);
    }
    const used = new Set(Object.values(data).map(String));
    for (const port of usedRaw) used.add(String(port));
    const start = Number(startRaw);
    const end = Number(endRaw);
    for (let port = start; port <= end; port += 1) {
      if (used.has(String(port))) continue;
      data[slug] = port;
      writeJson(file, data);
      process.stdout.write(String(port));
      process.exit(0);
    }
    console.error(`no free preview port in ${start}-${end}`);
    process.exit(1);
  } else if (action === "delete-port") {
    const [file, slug] = args;
    if (!file || !slug) usage();
    const data = readJson(file);
    delete data[slug];
    writeJson(file, data);
  } else {
    usage();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}

export { slugForBranch };
