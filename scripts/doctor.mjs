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
import { parseDotenvDev } from "./lib/env-dev.mjs";

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

export function checkEnvDev({ runtimeEnv = process.env, path = resolve(REPO_ROOT, ".env.dev") } = {}) {
  if (!existsSync(path)) {
    return { required: true, ok: false, label: ".env.dev", detail: "missing — run `cp .env.example .env.dev`" };
  }
  const env = { ...parseDotenvDev(readFileSync(path, "utf8"), {}), ...runtimeEnv };
  const missing = REQUIRED_ENV.filter((key) => !optionalEnv(env[key]));
  return {
    required: true,
    ok: missing.length === 0,
    label: ".env.dev required vars",
    detail: missing.length === 0 ? "all set" : `empty: ${missing.join(", ")}`,
    env,
  };
}

function optionalEnv(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function checkForgejo(env, { tcpOpenFn = tcpOpen } = {}) {
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
    ok: await tcpOpenFn(host, port),
    label: "Forgejo reachable",
    detail: `${host}:${port} (start it before pnpm setup:dev / dev:all)`,
    url,
  };
}

export async function checkForgejoRuntimeToken(env, { fetchImpl = fetch } = {}) {
  const url = env.COSHEAF_FORGEJO_URL ?? "http://127.0.0.1:3002";
  try {
    const response = await fetchImpl(new URL("/api/v1/user", url), {
      headers: { authorization: `token ${env.COSHEAF_FORGEJO_TOKEN}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { required: true, ok: false, label: "Forgejo runtime token", detail: "token rejected" };
    }
    if (!response.ok) {
      return { required: true, ok: false, label: "Forgejo runtime token", detail: `unexpected ${response.status}` };
    }
    const user = await response.json();
    if (user?.is_admin === true) {
      return {
        required: true,
        ok: false,
        label: "Forgejo runtime token",
        detail: "COSHEAF_FORGEJO_TOKEN is site-admin; use COSHEAF_FORGEJO_ADMIN_TOKEN for admin scope",
      };
    }
    return { required: true, ok: true, label: "Forgejo runtime token", detail: user?.login ?? "ok" };
  } catch (err) {
    return {
      required: true,
      ok: false,
      label: "Forgejo runtime token",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkForgejoAdminToken(env, { fetchImpl = fetch } = {}) {
  const url = env.COSHEAF_FORGEJO_URL ?? "http://127.0.0.1:3002";
  try {
    const response = await fetchImpl(new URL("/api/v1/admin/users?limit=1", url), {
      headers: { authorization: `token ${env.COSHEAF_FORGEJO_ADMIN_TOKEN}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { required: true, ok: false, label: "Forgejo admin token", detail: "token rejected (not admin?)" };
    }
    if (!response.ok) {
      return { required: true, ok: false, label: "Forgejo admin token", detail: `unexpected ${response.status}` };
    }
    return { required: true, ok: true, label: "Forgejo admin token", detail: "ok" };
  } catch (err) {
    return {
      required: true,
      ok: false,
      label: "Forgejo admin token",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runDoctor() {
  const results = [];
  results.push(checkNode());
  results.push(checkCoflat());
  const envCheck = checkEnvDev();
  results.push(envCheck);
  const forgejoCheck = await checkForgejo(envCheck.env ?? {});
  results.push(forgejoCheck);
  if (envCheck.ok && forgejoCheck.ok) {
    results.push(await checkForgejoRuntimeToken(envCheck.env));
    results.push(await checkForgejoAdminToken(envCheck.env));
  }

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
