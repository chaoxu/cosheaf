import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const distServer = path.join(root, "dist-server");
const required = path.join(distServer, "server", "schema.sql");
const forbidden = new Set([
  path.join(distServer, "server", "test-helpers.js"),
  path.join(distServer, "server", "test-helpers.d.ts"),
  path.join(distServer, "server", "routes", "test-fixtures.js"),
  path.join(distServer, "server", "routes", "test-fixtures.d.ts"),
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(required)) {
  console.error("server build is missing dist-server/server/schema.sql");
  process.exit(1);
}

const files = walk(distServer);
const bad = files.filter((file) => file.endsWith(".test.js") || file.endsWith(".test.d.ts") || forbidden.has(file));
if (bad.length > 0) {
  console.error("server build emitted test-only files:");
  for (const file of bad) console.error(`- ${path.relative(root, file)}`);
  process.exit(1);
}
