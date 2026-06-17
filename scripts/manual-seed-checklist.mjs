#!/usr/bin/env node
// Print the credentials and walk-through hints after `pnpm setup:dev:manual`.
// Pairs with SMOKE_CHECKLIST.md, which the operator runs from the freshly
// seeded state.

import { browserWebUrl } from "./browser-utils.mjs";
import { loadDotenvDev } from "./lib/env-dev.mjs";

loadDotenvDev();

const BASE = browserWebUrl();

const routes = [
  ["/chao/flushing-coin", "Coflat repo home"],
  ["/chao/flushing-coin/issues", "issue filters and list"],
  ["/chao/flushing-coin/pulls", "PR filters and list"],
  ["/chao/flushing-coin/activity", "activity feed and scroll behavior"],
  ["/chao/flushing-coin/src/branch/main/hello.md", "Coflat reader"],
  ["/chao/flushing-coin/_edit?branch=user/chao/manual-seed&path=manual-seed.md", "editor island"],
  ["/chao/passthrough-demo/issues", "passthrough issue rendering"],
  ["/chao/passthrough-demo/pulls", "passthrough PR rendering"],
];

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE,
        forgejoUrl: "http://127.0.0.1:3002",
        users: [
          { username: "chao", password: "Cosheaf123!", role: "admin", workspaces: ["chao/flushing-coin", "chao/passthrough-demo"] },
          { username: "test-vera", password: "Cosheaf123!", role: "write", workspaces: ["chao/flushing-coin", "chao/passthrough-demo"] },
          { username: "test-meri", password: "Cosheaf123!", role: "write", workspaces: ["chao/flushing-coin", "chao/passthrough-demo"] },
          { username: "test-bob", password: "Cosheaf123!", role: "read", workspaces: ["chao/flushing-coin", "chao/passthrough-demo"] },
        ],
        workspaces: [
          { slug: "chao/flushing-coin", format: "coflat" },
          { slug: "chao/passthrough-demo", format: "forgejo-passthrough" },
        ],
        routes: routes.map(([route, covers]) => ({ url: new URL(route, BASE).toString(), covers })),
        commands: ["pnpm dev:all", "pnpm dev:login-state", "pnpm devx:verify-route", "pnpm smoke:list"],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`
─────────────────────────────────────────────────────────────────────
 Agent seed ready. Two workspaces, four users, two markdown formats.
─────────────────────────────────────────────────────────────────────

  Cosheaf URL: ${BASE}
  Forgejo URL: http://127.0.0.1:3002

  Users (all password: Cosheaf123!):

    chao   admin  on both workspaces
    test-vera   write  on both workspaces
    test-meri   write  on both workspaces
    test-bob    read   on both workspaces

  Workspaces:

    chao/flushing-coin       (format: coflat)
       The math-flavored default; exercises backlinks, citations,
       and the rich diff renderer.

    chao/passthrough-demo    (format: forgejo-passthrough)
       The thin-shell flavor; backlinks panel stays empty, rich
       diff falls back to source diff, Forgejo's /markdown handles
       rendering.

  Agent route targets:

${routes.map(([route, covers]) => `    ${new URL(route, BASE).toString()}\n       ${covers}`).join("\n\n")}

  Agent commands:

    pnpm dev:all
    pnpm dev:login-state
    pnpm devx:verify-route
    pnpm devx:what-to-run
    pnpm smoke:list

─────────────────────────────────────────────────────────────────────
`);
