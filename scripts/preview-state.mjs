#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";

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
  const program = new Command("preview-state")
    .description("manage Cosheaf preview slug and port state");

  program
    .command("slug <branch>")
    .description("print the canonical preview slug for a branch")
    .action((branch) => {
      process.stdout.write(slugForBranch(branch));
    });

  program
    .command("read-port <file> <slug>")
    .description("print the persisted port for a preview slug, if present")
    .action((file, slug) => {
      const data = readJson(file);
      process.stdout.write(data[slug] ? String(data[slug]) : "");
    });

  program
    .command("allocate <file> <slug> <start> <end> [usedPorts...]")
    .description("allocate or reuse a preview port")
    .action((file, slug, startRaw, endRaw, usedRaw = []) => {
      const data = readJson(file);
      if (data[slug]) {
        process.stdout.write(String(data[slug]));
        return;
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
        return;
      }
      console.error(`no free preview port in ${start}-${end}`);
      process.exit(1);
    });

  program
    .command("delete-port <file> <slug>")
    .description("remove a preview slug from the port state file")
    .action((file, slug) => {
      const data = readJson(file);
      delete data[slug];
      writeJson(file, data);
    });

  program.parse(process.argv);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}

export { slugForBranch };
