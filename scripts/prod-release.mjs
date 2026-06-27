#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";
import { output, run } from "./lib/run.mjs";

const DEFAULT_FLEET_INFRA = path.resolve(process.cwd(), "..", "fleet-infra");
const WORKTREE_FLEET_INFRA = path.resolve(process.cwd(), "..", "..", "..", "fleet-infra");
const fleetInfra = process.env.FLEET_INFRA_CHECKOUT ?? firstExistingDir([DEFAULT_FLEET_INFRA, WORKTREE_FLEET_INFRA]) ?? DEFAULT_FLEET_INFRA;
const helper = path.join(fleetInfra, "bin", "cosheaf-pluto-release");
const actions = new Set(["release", "verify", "health", "doctor", "repo-check", "build-check"]);

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const [action = "release", ...rest] = positionals;

if (!actions.has(action)) {
  console.error(`usage: prod-release <${[...actions].join("|")}>`);
  console.error("production deploys target Pluto: https://cosheaf.chaoxu.prof");
  process.exit(2);
}

if (action === "release" && process.env.COSHEAF_CONFIRM_PROD_RELEASE !== "1") {
  console.error("Refusing production release without explicit confirmation.");
  console.error("Production is the public Pluto instance with real users.");
  console.error("After the user explicitly asks for production deploy, rerun with COSHEAF_CONFIRM_PROD_RELEASE=1.");
  process.exit(1);
}

if (!existsSync(helper)) {
  console.error(`missing Pluto release helper: ${helper}`);
  console.error("set FLEET_INFRA_CHECKOUT to the fleet-infra checkout path");
  process.exit(1);
}

if (action === "release" && prodAlreadyAtTarget()) {
  process.exit(0);
}

run(helper, [action, ...rest], {
  cwd: fleetInfra,
  env: {
    ...process.env,
    COSHEAF_CHECKOUT: process.env.COSHEAF_CHECKOUT ?? process.cwd(),
  },
});

function prodAlreadyAtTarget() {
  const targetSha = output("git", ["rev-parse", "HEAD"]);
  const targetCoflatRef = process.env.COFLAT_REF?.trim() || DEFAULT_COFLAT_REF;
  const body = output("curl", ["-fsS", "https://cosheaf.chaoxu.prof/api/v1/health"], { allowFailure: true });
  if (!body) return false;
  try {
    const health = JSON.parse(body);
    if (health.commit === targetSha && health.coflat_ref === targetCoflatRef) {
      console.log(`production already running ${targetSha} coflat=${targetCoflatRef}; skipping release`);
      return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function firstExistingDir(candidates) {
  return candidates.find((candidate) => existsSync(candidate));
}
