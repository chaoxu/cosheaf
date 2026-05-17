#!/usr/bin/env node
// Print the credentials and walk-through hints after `pnpm setup:dev:manual`.
// Pairs with SMOKE_CHECKLIST.md, which the operator runs from the freshly
// seeded state.

const BASE = process.env.URL ?? "http://localhost:5173";

console.log(`
─────────────────────────────────────────────────────────────────────
 Manual seed ready. Two workspaces, four users, two markdown formats.
─────────────────────────────────────────────────────────────────────

  Cosheaf URL: ${BASE}
  Forgejo URL: http://127.0.0.1:3002

  Users (all password: Cosheaf123!):

    chao   admin  on both workspaces
    vera   write  on both workspaces
    meri   write  on both workspaces
    bob    read   on both workspaces

  Workspaces:

    flushing-coin       (format: coflat)
       The math-flavored default; exercises backlinks, citations,
       and the rich diff renderer.

    passthrough-demo    (format: forgejo-passthrough)
       The thin-shell flavor; backlinks panel stays empty, rich
       diff falls back to source diff, Forgejo's /markdown handles
       rendering.

  Run through SMOKE_CHECKLIST.md to exercise every path on both
  workspaces. Sections 5–7 (branches, PRs, issues) require some
  interactive work that this seed doesn't pre-populate — by design,
  so you walk those flows manually and verify they behave the same
  on each format.

─────────────────────────────────────────────────────────────────────
`);
