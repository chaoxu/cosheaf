#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { DEFAULT_COFLAT_REF, checkDocPins } from "./check-coflat-ref.mjs";

function output(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
  } catch (_err) {
    return null;
  }
}

function localCoflatHead() {
  return output("git", ["-C", "../coflat", "rev-parse", "HEAD"]);
}

function localCosheafHead() {
  return output("git", ["rev-parse", "HEAD"]);
}

function lockfileCoflatEntry() {
  if (!existsSync("pnpm-lock.yaml")) return null;
  const text = readFileSync("pnpm-lock.yaml", "utf8");
  const match = text.match(/@chaoxu\/coflat@file:\.\.\/coflat\(([^)]+)\)/);
  return match?.[1] ?? null;
}

function deployedCosheafSha() {
  const healthJson = output("curl", ["-fsS", "https://cosheaf.lab/api/v1/health"]);
  if (healthJson) {
    try {
      const health = JSON.parse(healthJson);
      if (typeof health.commit === "string" && /^[0-9a-f]{40}$/.test(health.commit)) return health.commit;
    } catch (_err) {
      // Fall through to the jupiter-side health check below.
    }
  }
  const cmd = [
    "cd /home/chaoxu/playground/cosheaf",
    "COSHEAF_JUPITER_LOCAL=1",
    "node /srv/fleet-infra/apps/cosheaf/scripts/jupiter-release.mjs health prod",
  ].join(" && ");
  const result = output("ssh", ["jupiter", cmd]);
  if (!result) return null;
  const match = result.match(/\b[0-9a-f]{40}\b/);
  return match?.[0] ?? null;
}

export function coflatStatus({ prod = false } = {}) {
  const localHead = localCoflatHead();
  const docDrift = checkDocPins();
  return {
    expectedCoflatRef: DEFAULT_COFLAT_REF,
    localCoflatHead: localHead,
    localCoflatMatchesPin: localHead === DEFAULT_COFLAT_REF,
    lockfileCoflatHash: lockfileCoflatEntry(),
    pinDrift: docDrift,
    localCosheafHead: localCosheafHead(),
    ...(prod ? { deployedCosheafSha: deployedCosheafSha() } : {}),
  };
}

function printStatus(status) {
  console.log(`Coflat pin:        ${status.expectedCoflatRef}`);
  console.log(`../coflat HEAD:    ${status.localCoflatHead ?? "<missing>"}`);
  console.log(`pin match:         ${status.localCoflatMatchesPin ? "yes" : "no"}`);
  console.log(`lockfile hash:     ${status.lockfileCoflatHash ?? "<missing>"}`);
  console.log(`Cosheaf HEAD:      ${status.localCosheafHead ?? "<missing>"}`);
  if ("deployedCosheafSha" in status) {
    console.log(`prod Cosheaf SHA:  ${status.deployedCosheafSha ?? "<unavailable>"}`);
  }
  if (status.pinDrift.length > 0) {
    console.log("pin drift:");
    for (const item of status.pinDrift) console.log(`  - ${item.file}: ${item.found}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = new Command("coflat-status")
    .option("--prod", "also query jupiter production container state", false)
    .option("--json", "print machine-readable JSON", false)
    .action((opts) => {
      const status = coflatStatus({ prod: opts.prod });
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
      process.exitCode = status.localCoflatMatchesPin && status.pinDrift.length === 0 ? 0 : 1;
    });
  program.parse();
}
