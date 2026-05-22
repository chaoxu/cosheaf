#!/usr/bin/env node

import { smokeChecks } from "./smoke-manifest.mjs";

const rows = smokeChecks.map((check) => ({
  command: check.command,
  seed: check.seed,
  destructive: check.destructive ? "yes" : "no",
  prod: check.prod ? "yes" : "preview only by default",
  covers: check.covers,
}));

const widths = {
  command: Math.max(...rows.map((c) => c.command.length), "command".length),
  seed: Math.max(...rows.map((c) => c.seed.length), "seed".length),
  destructive: Math.max(...rows.map((c) => c.destructive.length), "destructive".length),
  prod: Math.max(...rows.map((c) => c.prod.length), "prod".length),
};

function pad(value, width) {
  return value.padEnd(width, " ");
}

console.log(
  [
    pad("command", widths.command),
    pad("seed", widths.seed),
    pad("destructive", widths.destructive),
    pad("prod", widths.prod),
    "covers",
  ].join("  "),
);
console.log(
  [
    "-".repeat(widths.command),
    "-".repeat(widths.seed),
    "-".repeat(widths.destructive),
    "-".repeat(widths.prod),
    "------",
  ].join("  "),
);
for (const check of rows) {
  console.log(
    [
      pad(check.command, widths.command),
      pad(check.seed, widths.seed),
      pad(check.destructive, widths.destructive),
      pad(check.prod, widths.prod),
      check.covers,
    ].join("  "),
  );
}

