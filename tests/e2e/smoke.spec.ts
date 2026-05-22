import { spawnSync } from "node:child_process";
import { test } from "@playwright/test";
import { smokeChecks } from "../../scripts/smoke-manifest.mjs";

function runSmokeScript(script: string, name: string): void {
  const slug = (process.env.URL ?? "local").replace(/[^a-z0-9]/gi, "-");
  const result = spawnSync("node", [script], {
    stdio: "inherit",
    env: {
      ...process.env,
      SCREENSHOT: process.env.SCREENSHOT ?? `/tmp/cosheaf-${slug}-${name}.png`,
      COSHEAF_FLOW_PATH: process.env.COSHEAF_FLOW_PATH ?? `${slug}-${name}-${Date.now()}.md`,
    },
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit ${result.status ?? 1}`);
  }
}

for (const check of smokeChecks) {
  test(`${check.name} ${check.grep}`, async () => {
    runSmokeScript(check.script, check.name);
  });
}

