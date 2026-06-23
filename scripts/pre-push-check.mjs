#!/usr/bin/env node

import { runFastGate, runWithPinnedFallback } from "./lib/pinned-coflat-gate.mjs";

runWithPinnedFallback({
  gate: runFastGate,
  isolatedGate: runFastGate,
  source: "head",
  fallbackMessage: "Running pre-push checks in an isolated pinned Coflat worktree.",
});
