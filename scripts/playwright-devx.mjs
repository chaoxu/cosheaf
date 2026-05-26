#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const result = spawnSync("pnpm", ["exec", "playwright", "test", ...args], {
  stdio: "inherit",
  env: process.env,
});

if ((result.status ?? 1) !== 0) summarizeFailures();
process.exit(result.status ?? 1);

function summarizeFailures() {
  const root = path.join(process.cwd(), "test-results");
  if (!existsSync(root)) return;
  const dirs = walk(root).filter((file) => file.endsWith("error-context.md")).map((file) => path.dirname(file));
  if (dirs.length === 0) return;

  console.error("\nDevX Playwright failure summary:");
  for (const dir of dirs.slice(0, 5)) {
    const rel = path.relative(process.cwd(), dir);
    console.error(`- ${rel}`);
    for (const name of ["error-context.md", "test-failed-1.png", "trace.zip", "video.webm"]) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) console.error(`  ${name}: ${path.relative(process.cwd(), candidate)}`);
    }
    const owner = likelyOwner(rel);
    if (owner) console.error(`  likely owner: ${owner}`);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function likelyOwner(text) {
  if (text.includes("settings")) return "server/routes/web.ts, public/cosheaf-web.css";
  if (text.includes("web-pages")) return "server/routes/web.ts, public/cosheaf-web.css, tests/e2e/web-pages.spec.ts";
  if (text.includes("smoke")) return "scripts/smoke-manifest.mjs, tests/e2e/smoke.spec.ts";
  return "";
}
