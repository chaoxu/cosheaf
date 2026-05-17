#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";

const contract = JSON.parse(readFileSync("api-contract.json", "utf8"));
const passthroughSource = readFileSync("server/routes/forgejo-passthrough.ts", "utf8");
const docs = ["API.md", "AGENTS.md", "README.md", "DESIGN.md"]
  .map((path) => `${path}\n${readFileSync(path, "utf8")}`)
  .join("\n\n");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function sorted(value) {
  return [...value].sort();
}

const sourceAllowed = new Map();
const allowRe = /\{\s*prefix:\s*"([^"]+)",\s*methods:\s*new Set<Method>\(\[([^\]]*)\]\)\s*\}/g;
let match;
while ((match = allowRe.exec(passthroughSource)) !== null) {
  const methods = [...match[2].matchAll(/"([A-Z]+)"/g)].map((m) => m[1]);
  sourceAllowed.set(match[1], sorted(methods));
}

const contractAllowed = new Map(
  contract.passthrough.allowed.map((entry) => [entry.prefix, sorted(entry.methods)]),
);

const sourceKeys = sorted(sourceAllowed.keys());
const contractKeys = sorted(contractAllowed.keys());
if (JSON.stringify(sourceKeys) !== JSON.stringify(contractKeys)) {
  fail(`passthrough prefixes differ: source=${sourceKeys.join(",")} contract=${contractKeys.join(",")}`);
}

for (const [prefix, methods] of contractAllowed) {
  const sourceMethods = sourceAllowed.get(prefix);
  if (JSON.stringify(methods) !== JSON.stringify(sourceMethods)) {
    fail(`passthrough methods differ for ${prefix}: source=${sourceMethods?.join(",")} contract=${methods.join(",")}`);
  }
}

const requiredDocSnippets = [
  "Authorization: Bearer <Forgejo PAT>",
  "/api/v1/w/:slug/forgejo/*",
  "pulls/:n/merge",
  "frontmatter/id",
  "forgejo_passthrough_log",
];
for (const snippet of requiredDocSnippets) {
  if (!docs.includes(snippet)) fail(`missing API boundary doc snippet: ${snippet}`);
}

const staleDocPatterns = [
  /\bBearer cs_/,
  /\bcs_\.\.\./,
  /Sudo/,
  /\/api\/v1\/forgejo\/\.\.\./,
  /\/w\/:slug\/changes/,
  /\/w\/:slug\/change\b/,
  /\/w\/:slug\/publish/,
  /branchId/,
  /\bBranchState\b/,
];
for (const pattern of staleDocPatterns) {
  if (pattern.test(docs)) fail(`stale API documentation pattern found: ${pattern}`);
}

if (!process.exitCode) {
  console.log("API contract matches passthrough policy and docs.");
}
