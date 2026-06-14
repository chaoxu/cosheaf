#!/usr/bin/env node
// Run the cosheaf API server (tsx watch server/index.ts) and the Vite dev
// server together, forwarding logs and signals. No extra deps.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { checkCoflatRef, checkDocPins, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

function loadDotenvDev() {
  const file = resolve(process.cwd(), ".env.dev");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenvDev();

const apiPort = process.env.COSHEAF_PORT ?? "3030";
const vitePort = process.env.COSHEAF_VITE_PORT ?? "5173";
const apiUrl = `http://localhost:${apiPort}`;
const viteUrl = `http://localhost:${vitePort}`;
const proxyUrl = process.env.COSHEAF_SERVER_URL ?? apiUrl;

function portAvailable(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(Number(port));
  });
}

const blocked = [];
if (!(await portAvailable(apiPort))) blocked.push(apiUrl);
if (!(await portAvailable(vitePort))) blocked.push(viteUrl);
if (blocked.length > 0) {
  console.error(`Cannot start dev servers; port already in use: ${blocked.join(", ")}`);
  process.exit(1);
}

// Non-blocking coflat pin notice: a stale sibling checkout or a doc that drifted
// from DEFAULT_COFLAT_REF is the classic "works on my machine" trap. Warn loudly
// at dev start; never block (setup:deps and check:pre-push are the hard gates).
const coflat = checkCoflatRef();
if (!coflat.ok) {
  process.stdout.write(`\x1b[33m⚠ coflat: ${coflat.message}\x1b[0m\n`);
}
for (const drift of checkDocPins()) {
  process.stdout.write(`\x1b[33m⚠ coflat pin drift: ${drift.file} says ${drift.found}, expected ${DEFAULT_COFLAT_REF} (pnpm bump:coflat)\x1b[0m\n`);
}

process.stdout.write(`Cosheaf dev\n`);
process.stdout.write(`  web: ${apiUrl}\n`);
process.stdout.write(`  page island dev assets: ${viteUrl}\n`);
process.stdout.write(`  api: ${apiUrl}\n`);
process.stdout.write(`  vite proxy: ${proxyUrl}\n\n`);
process.stdout.write(`Agent checks\n`);
process.stdout.write(`  route browser check: pnpm devx:verify-route\n`);
process.stdout.write(`  changed-file gates: pnpm devx:what-to-run\n`);
process.stdout.write(`  smoke matrix: pnpm smoke:list\n\n`);

const procs = [
  {
    name: "server",
    cmd: "pnpm",
    args: ["exec", "tsx", "watch", "server/index.ts"],
    color: "\x1b[36m",
  },
  { name: "vite", cmd: "pnpm", args: ["exec", "vite", "--strictPort", "--port", vitePort], color: "\x1b[35m" },
];
const reset = "\x1b[0m";

const children = procs.map(({ name, cmd, args, color }) => {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = `${color}[${name}]${reset}`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${tag} ${line}\n`);
    });
  }
  child.on("exit", (code, signal) => {
    process.stdout.write(`${tag} exited (code=${code} signal=${signal})\n`);
    shutdown(code ?? 0);
  });
  return child;
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}
