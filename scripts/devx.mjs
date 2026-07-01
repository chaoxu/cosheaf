#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { Command } from "commander";
import { defaultWebUrl, loadDotenvDev } from "./lib/env-dev.mjs";
import { smokeChecks } from "./smoke-manifest.mjs";
import { run } from "./lib/run.mjs";

export function buildProgram() {
  const program = new Command("devx");
  program
    .command("ready", { isDefault: true })
    .description("prepare an agent-ready local Cosheaf workspace")
    .option("--no-seed", "skip setup:dev:manual")
    .option("--no-login-state", "skip writing Playwright login state")
    .option("--no-server", "do not start dev:all if the local Cosheaf web URL is down")
    .option("--url <url>", "local web URL", defaultWebUrl())
    .action((opts) => ready(opts));
  return program;
}

export async function main(argv = process.argv) {
  loadDotenvDev();
  await buildProgram().parseAsync(normalizeArgv(argv));
}

async function ready(opts) {
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
    "/chao/flushing-coin/src/branch/main?mode=edit&path=devx-ready.md&edit_branch=user%2Fchao%2Fdevx-ready",
    "/chao/coflat-demo/issues",
    "/chao/coflat-demo/pulls",
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

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
