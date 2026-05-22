#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";

const contract = JSON.parse(readFileSync("api-contract.json", "utf8"));
const docs = ["API.md", "AGENTS.md", "README.md", "DESIGN.md"]
  .map((path) => `${path}\n${readFileSync(path, "utf8")}`)
  .join("\n\n");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if ("passthrough" in contract) {
  fail("api-contract.json must not expose a backend passthrough surface");
}

const requiredDocSnippets = [
  "Authorization: Bearer <token>",
  "typed Cosheaf workspace API",
  "pulls/:n/merge",
  "frontmatter/id",
];
for (const snippet of requiredDocSnippets) {
  if (!docs.includes(snippet)) fail(`missing API boundary doc snippet: ${snippet}`);
}

const staleDocPatterns = [
  /\bBearer cs_/,
  /\bcs_\.\.\./,
  /\/api\/v1\/w\/:slug\/forgejo\/\*/,
  /\{METHOD\}\s+\/w\/:slug\/forgejo\/:tail/,
  /Backend Escape Hatch/,
  /internal\/compatibility escape\s+hatch/,
  /Allowed repo-scoped passthrough prefixes/,
  /Sudo/,
  /\/api\/v1\/forgejo\/\.\.\./,
  /\/w\/:slug\/changes/,
  /\/w\/:slug\/change\b/,
  /\/w\/:slug\/publish/,
  /api\/v1\/w\/flushing-coin\/forgejo/,
  /api\/v1\/w\/\$SLUG\/forgejo/,
  /Forgejo passthrough should/,
  /Forgejo passthrough first/,
  /branchId/,
  /\bBranchState\b/,
];
for (const pattern of staleDocPatterns) {
  if (pattern.test(docs)) fail(`stale API documentation pattern found: ${pattern}`);
}

if (!process.exitCode) {
  console.log("API contract docs do not expose backend passthrough.");
}
