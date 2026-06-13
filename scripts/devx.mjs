#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { Command } from "commander";
import { smokeChecks } from "./smoke-manifest.mjs";
import { run } from "./lib/run.mjs";

const program = new Command("devx");

program
  .command("ready", { isDefault: true })
  .description("prepare an agent-ready local Cosheaf workspace")
  .option("--no-seed", "skip setup:dev:manual")
  .option("--no-login-state", "skip writing Playwright login state")
  .option("--no-server", "do not start dev:all if http://localhost:3030 is down")
  .option("--url <url>", "local web URL", process.env.COSHEAF_WEB_URL ?? "http://localhost:3030")
  .action((opts) => ready(opts));

program.parse(normalizeArgv(process.argv));

async function ready(opts) {
  loadDotenvDev();
  const host = readHost();
  console.log(`Cosheaf agent DevX on ${host}`);
  const forgejoOpen = await portOpen("127.0.0.1", 3002);
  if (!forgejoOpen) {
    console.error("Forgejo is not reachable on 127.0.0.1:3002. Cosheaf does not use the unrelated service on 3001.");
    process.exit(1);
  }
  console.log("OK Forgejo port 3002 is reachable");

  if (opts.seed) run("pnpm", ["setup:dev:manual"]);

  let child;
  if (!(await healthOk(opts.url))) {
    if (!opts.server) {
      console.error(`${opts.url} is not healthy and --no-server was passed`);
      process.exit(1);
    }
    child = spawn("pnpm", ["dev:all"], { stdio: "inherit", env: process.env });
    await waitForHealth(opts.url);
  }

  if (opts.loginState) {
    run("pnpm", ["dev:login-state"], {
      env: { ...process.env, COSHEAF_WEB_URL: opts.url },
    });
  }

  console.log("\nAgent-ready routes:");
  for (const route of [
    "/chao/flushing-coin/activity",
    "/chao/flushing-coin/issues",
    "/chao/flushing-coin/pulls",
    "/chao/flushing-coin/src/branch/main/hello.md",
    "/chao/flushing-coin/_edit?branch=user/chao/devx-ready&path=devx-ready.md",
    "/chao/passthrough-demo/issues",
    "/chao/passthrough-demo/pulls",
  ]) {
    console.log(`  ${new URL(route, opts.url).toString()}`);
  }

  console.log("\nFocused browser checks:");
  for (const check of smokeChecks) console.log(`  ${check.command}  # ${check.covers}`);
  console.log("  pnpm devx:verify-route  # route scroll/filter/assets/console checks");
  console.log("  pnpm devx:what-to-run  # changed-file check suggestions");

  if (child) {
    console.log("\nDev server is running. Stop this command with Ctrl-C when done.");
    await new Promise((resolveDone) => {
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
          child.kill("SIGTERM");
          resolveDone(undefined);
        });
      }
      child.on("exit", resolveDone);
    });
  }
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

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

function readHost() {
  try {
    return readFileSync("/etc/lab-host", "utf8").trim() || "unknown";
  } catch (_error) {
    return "unknown";
  }
}

function portOpen(host, port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.end();
      resolvePort(true);
    });
    socket.once("error", () => resolvePort(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolvePort(false);
    });
  });
}

async function healthOk(baseUrl) {
  try {
    const response = await fetch(new URL("/api/v1/health", baseUrl));
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function waitForHealth(baseUrl) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (await healthOk(baseUrl)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${baseUrl} did not become healthy within 30s`);
}
