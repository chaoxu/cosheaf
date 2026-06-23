#!/usr/bin/env node

import { runLocalGate, runWithPinnedFallback } from "./lib/pinned-coflat-gate.mjs";

runWithPinnedFallback({
  gate: runLocalGate,
  isolatedGate: runLocalGate,
  source: "working-tree",
  fallbackMessage: "Running the local gate in an isolated pinned Coflat worktree.",
});
