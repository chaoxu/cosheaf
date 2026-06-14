#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_COFLAT_REF = "5ddc22686e211239a72f90acffdb4b7b6c6fe869";

export function checkCoflatRef({
  coflatDir = resolve(process.cwd(), "..", "coflat"),
  expectedRef = process.env.COFLAT_REF ?? DEFAULT_COFLAT_REF,
  execFile = execFileSync,
} = {}) {
  if (!existsSync(coflatDir)) {
    return {
      ok: false,
      message: `missing sibling Coflat checkout: ${coflatDir}`,
    };
  }

  let actualRef = "";
  try {
    actualRef = execFile("git", ["-C", coflatDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (err) {
    return {
      ok: false,
      message: `could not read Coflat git revision at ${coflatDir}: ${err.message}`,
    };
  }

  if (actualRef !== expectedRef) {
    return {
      ok: false,
      message: `Coflat checkout is ${actualRef}, expected ${expectedRef}. Run: git -C ${coflatDir} fetch origin ${expectedRef} && git -C ${coflatDir} checkout ${expectedRef}`,
    };
  }

  return { ok: true, actualRef };
}

export function main() {
  const result = checkCoflatRef();
  if (result.ok) return 0;
  console.error(result.message);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
