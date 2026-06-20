#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { run } from "./lib/run.mjs";

const DEFAULT_FLEET_INFRA = path.resolve(process.cwd(), "..", "fleet-infra");
const fleetInfra = process.env.FLEET_INFRA_CHECKOUT ?? DEFAULT_FLEET_INFRA;
const helper = path.join(fleetInfra, "bin", "cosheaf-pluto-release");
const actions = new Set(["release", "verify", "health", "doctor", "repo-check"]);

const { positionals } = parseArgs({ allowPositionals: true });
const [action = "release", ...rest] = positionals;

if (!actions.has(action)) {
  console.error(`usage: prod-release <${[...actions].join("|")}>`);
  console.error("production deploys target Pluto: https://cosheaf.chaoxu.prof");
  process.exit(2);
}

if (!existsSync(helper)) {
  console.error(`missing Pluto release helper: ${helper}`);
  console.error("set FLEET_INFRA_CHECKOUT to the fleet-infra checkout path");
  process.exit(1);
}

run(helper, [action, ...rest], {
  cwd: fleetInfra,
  env: {
    ...process.env,
    COSHEAF_CHECKOUT: process.env.COSHEAF_CHECKOUT ?? process.cwd(),
  },
});
