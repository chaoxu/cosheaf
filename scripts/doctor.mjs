#!/usr/bin/env node

// Read-only environment preflight: a single "is my local setup sane?" check for
// new contributors and agents. Unlike `devx:ready` it starts/seeds nothing — it
// only inspects and reports. Required checks (Node, Coflat pin, .env.dev) fail
// the command; Forgejo reachability is an advisory warning.

import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { checkCoflatRef, checkDocPins, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_ENV = ["COSHEAF_FORGEJO_TOKEN", "COSHEAF_FORGEJO_ADMIN_TOKEN", "COSHEAF_WEBHOOK_SECRET"];

function tcpOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function parseEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

// Each check returns { ok, label, detail, required }.
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    required: true,
    ok: major >= 24,
    label: "Node >= 24",
    detail: `found ${process.versions.node}`,
  };
}

function checkCoflat() {
  const ref = checkCoflatRef();
  if (!ref.ok) return { required: true, ok: false, label: "Coflat sibling checkout", detail: ref.message };
  const drift = checkDocPins();
  if (drift.length > 0) {
    return {
      required: true,
      ok: false,
      label: "Coflat pin",
      detail: `doc drift: ${drift.map((d) => `${d.file}=${d.found}`).join(", ")} (pnpm bump:coflat ${DEFAULT_COFLAT_REF})`,
    };
  }
  return { required: true, ok: true, label: "Coflat pin", detail: DEFAULT_COFLAT_REF };
}

function checkEnvDev() {
  const path = resolve(REPO_ROOT, ".env.dev");
  if (!existsSync(path)) {
    return { required: true, ok: false, label: ".env.dev", detail: "missing — run `cp .env.example .env.dev`" };
  }
  const env = parseEnvFile(path);
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  return {
    required: true,
    ok: missing.length === 0,
    label: ".env.dev required vars",
    detail: missing.length === 0 ? "all set" : `empty: ${missing.join(", ")}`,
    env,
  };
}

async function checkForgejo(env) {
  const url = env.COSHEAF_FORGEJO_URL ?? "http://127.0.0.1:3002";
  let host = "127.0.0.1";
  let port = 3002;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  } catch (_err) {
    // fall back to defaults
  }
  return {
    required: false,
    ok: await tcpOpen(host, port),
    label: "Forgejo reachable",
    detail: `${host}:${port} (start it before pnpm setup:dev / dev:all)`,
  };
}

async function runDoctor() {
  const results = [];
  results.push(checkNode());
  results.push(checkCoflat());
  const envCheck = checkEnvDev();
  results.push(envCheck);
  results.push(await checkForgejo(envCheck.env ?? {}));

  for (const r of results) {
    const mark = r.ok ? "✓" : r.required ? "✗" : "⚠";
    console.log(`${mark} ${r.label}: ${r.detail}`);
  }

  const failed = results.filter((r) => r.required && !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} required check(s) failed.`);
    return 1;
  }
  const warned = results.filter((r) => !r.required && !r.ok);
  console.log(warned.length > 0 ? `\nReady (with ${warned.length} warning(s)).` : "\nReady.");
  return 0;
}

const program = new Command();
program
  .name("doctor")
  .description("Read-only preflight: Node, Coflat pin, .env.dev, Forgejo")
  .action(async () => {
    process.exitCode = await runDoctor();
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  await program.parseAsync();
}
