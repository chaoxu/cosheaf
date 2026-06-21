#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { checkDocPins, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

const prodUrl = process.env.COSHEAF_PROD_URL ?? "https://cosheaf.chaoxu.prof";

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

function deployedHealth() {
  const healthJson = output("curl", ["-fsS", `${prodUrl.replace(/\/+$/, "")}/api/v1/health`]);
  if (healthJson) {
    try {
      const health = JSON.parse(healthJson);
      if (health && typeof health === "object") return health;
    } catch (_err) {
      return null;
    }
  }
  return null;
}

export function coflatStatus({ prod = false } = {}) {
  const localHead = localCoflatHead();
  const docDrift = checkDocPins();
  const health = prod ? deployedHealth() : null;
  const localCosheaf = localCosheafHead();
  const deployedCosheafSha = typeof health?.commit === "string" ? health.commit : null;
  const deployedCoflatRef = typeof health?.coflat_ref === "string" ? health.coflat_ref : null;
  return {
    expectedCoflatRef: DEFAULT_COFLAT_REF,
    localCoflatHead: localHead,
    localCoflatMatchesPin: localHead === DEFAULT_COFLAT_REF,
    lockfileCoflatHash: lockfileCoflatEntry(),
    pinDrift: docDrift,
    localCosheafHead: localCosheaf,
    ...(prod ? {
      deployedCosheafSha,
      deployedCoflatRef,
      deployedCosheafMatchesLocal: deployedCosheafSha === localCosheaf,
      deployedCoflatMatchesPin: deployedCoflatRef === DEFAULT_COFLAT_REF,
    } : {}),
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
    console.log(`prod Coflat ref:   ${status.deployedCoflatRef ?? "<unavailable>"}`);
    console.log(`prod SHA match:    ${status.deployedCosheafMatchesLocal ? "yes" : "no"}`);
    console.log(`prod ref match:    ${status.deployedCoflatMatchesPin ? "yes" : "no"}`);
  }
  if (status.pinDrift.length > 0) {
    console.log("pin drift:");
    for (const item of status.pinDrift) console.log(`  - ${item.file}: ${item.found}`);
  }
}

export function statusExitOk(status, { prod = false } = {}) {
  return prod
    ? status.pinDrift.length === 0 &&
        status.deployedCosheafMatchesLocal &&
        status.deployedCoflatMatchesPin
    : status.localCoflatMatchesPin && status.pinDrift.length === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = new Command("coflat-status")
    .option("--prod", "also query production container state", false)
    .option("--json", "print machine-readable JSON", false)
    .action((opts) => {
      const status = coflatStatus({ prod: opts.prod });
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else printStatus(status);
      process.exitCode = statusExitOk(status, { prod: opts.prod }) ? 0 : 1;
    });
  program.parse();
}
