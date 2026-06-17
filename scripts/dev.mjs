#!/usr/bin/env node
// Run the cosheaf API server (tsx watch server/index.ts) and the Vite dev
// server together, forwarding logs and signals. No extra deps.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { checkCoflatRef, checkDocPins, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";
import { defaultApiUrl, defaultServerUrl, defaultViteUrl, defaultWebUrl, loadDotenvDev, serverPort, vitePort } from "./lib/env-dev.mjs";

loadDotenvDev();

const apiPort = serverPort();
const viteDevPort = vitePort();
const localApiUrl = `http://localhost:${apiPort}`;
const localViteUrl = `http://localhost:${viteDevPort}`;
const webUrl = defaultWebUrl();
const apiUrl = defaultApiUrl();
const viteUrl = defaultViteUrl();
const proxyUrl = defaultServerUrl();
const viteHostArgs = viteBindHostArgs(viteUrl);

function viteBindHostArgs(origin) {
  if (!origin) return [];
  let hostname;
  try {
    hostname = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
  } catch (_err) {
    return [];
  }
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return [];
  return ["--host", "0.0.0.0"];
}

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
if (!(await portAvailable(apiPort))) blocked.push(localApiUrl);
if (!(await portAvailable(viteDevPort))) blocked.push(localViteUrl);
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
process.stdout.write(`  web: ${webUrl}\n`);
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
  { name: "vite", cmd: "pnpm", args: ["exec", "vite", "--strictPort", "--port", viteDevPort, ...viteHostArgs], color: "\x1b[35m" },
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
