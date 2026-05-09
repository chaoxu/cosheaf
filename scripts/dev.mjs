#!/usr/bin/env node
// Run the cosheaf API server (tsx watch server/index.ts) and the Vite dev
// server together, forwarding logs and signals. No extra deps.

import { spawn } from "node:child_process";

const procs = [
  { name: "server", cmd: "pnpm", args: ["server"], color: "\x1b[36m" }, // cyan
  { name: "vite", cmd: "pnpm", args: ["dev"], color: "\x1b[35m" }, // magenta
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
