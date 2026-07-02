# Cosheaf DevX

## Agent Entry Points

- `docs/AI_CLIENTS.md` is the short public contract for AI tools that use
  Cosheaf workspaces. Start there when an agent needs to edit pages, open a PR,
  review, merge, or triage issues through the typed API instead of the backing
  Forgejo service.
- `docs/workbench-origin-split.md` is the design contract for Workbench versus
  Cosheaf server authority, Origin API terminology, multi-server scoping, and
  local Workbench security boundaries.
- `pnpm cosheaf:tea -- --workspace <owner>/<repo> pr-from-files ...` is the
  tea-shaped helper for the common local-files-to-Cosheaf-PR flow.
- `pnpm devx:ready` prepares a local agent workspace: checks Forgejo `3002`,
  runs the manual seed, starts `pnpm dev:all` if needed, writes Playwright login
  state, and prints route targets plus focused checks.
- `pnpm devx:what-to-run` inspects changed files and prints the smallest useful
  verification set. It considers dirty files first, then unpushed commits
  against the upstream branch. Pass explicit files to bypass git detection, or
  `--json` when another script should consume the result.
- `pnpm devx:pending` summarizes dirty/unpushed work, touched files, suggested
  checks, and push readiness.
- `pnpm devx:review-prompt` prints a reviewer prompt from the pending work. Add
  `--verification "..."` or `--verification-file <path>` to include checks
  already run.
- `pnpm devx:verify-route` opens real browser pages and checks HTTP status,
  global-header scroll behavior, issue/PR filter visibility, asset 4xxs, and
  console errors. Defaults to the seeded activity/issues/pulls routes.
- `pnpm check:pr-rich -- <url|route|fixture>` opens a PR file page in
  rich/source split and after variants, waits for Coflat hydration, checks
  unresolved xrefs/citations, change-step counts, console/page errors, failed
  asset/raw responses, screenshots, and render-ref provenance.
- `pnpm staging:check-page -- <url|route|fixture>` runs the same rich-page
  checker against `https://cosheaf-test.lab/`.
- `pnpm prod:release` deploys Cosheaf production to Pluto
- `pnpm prod:build-check` builds the production image on `jupiter` without deploying
  (`https://cosheaf.chaoxu.prof`) through the fleet-infra Pluto release helper.
  Do not run it during normal work; production has real users and should only
  be deployed after the user explicitly asks. Normal live verification uses
  `cosheaf-test.lab`.
- `pnpm staging:deploy` deploys the current pushed commit to the isolated
  `cosheaf-test.lab` staging instance on `jupiter`.
- `pnpm staging:verify` checks staging health and verifies that staging is
  running the current pushed commit.
- `pnpm staging:e2e` runs stable non-destructive browser smoke against
  `cosheaf-test.lab`, plus a focused reader/editor reference-hover canary.
- `pnpm staging:refs` runs only the focused staging reference-hover canary.
- `pnpm staging:check-page -- <url|route|fixture>` is the focused live checker
  for a specific reader or PR file URL. It is the fastest way to verify "why is
  this reference red?" or "why does diff navigation say no changes?" on staging.
- `pnpm staging:gate` runs the local gate, deploys the current pushed commit to
  staging, verifies health, and runs staging browser smoke.
- `pnpm coflat:status` prints the pinned Coflat SHA, sibling checkout SHA,
  lockfile hash, and local Cosheaf SHA. Add `--prod` to also query the
  deployed production Cosheaf SHA and Coflat ref at
  `https://cosheaf.chaoxu.prof` on `pluto`. Set `COSHEAF_PROD_URL` to query a
  different production-compatible health endpoint.
- `pnpm refresh:coflat` builds `../coflat`, installs with lifecycle scripts
  disabled, and rebuilds native packages. It avoids the local lefthook
  `core.hooksPath` failure that made the old refresh path unreliable.
- `pnpm verify:cogirth-outline` is an optional live canary for the active
  Cogirth editing target. It is not the standard parity gate; use the seeded
  `pnpm smoke:reader-parity` fixture for durable outline/hover regressions.

## Fast Checks

- `pnpm check:local` runs the normal local gate: static checks, unit tests, Vite build, and server build.
  If `../coflat` is dirty or on another branch, it runs that gate in an
  isolated copy of the current Cosheaf working tree with a pinned Coflat
  worktree. Use `pnpm check:local:direct` only when you specifically want the
  raw local sequence.
- `pnpm check:pinned` is an explicit alias for the pinned-aware full local gate.
- `pnpm check:pre-push` runs the faster type/lint gate and uses the same shared
  pinned-Coflat fallback against committed `HEAD`.
- `pnpm check:web:fast` runs the smaller server-rendered UI gate for low-risk
  markup/CSS changes: types, focused web route tests, Vite build, and server
  build.
- `pnpm check:web` runs the full server-rendered web page flow and prints
  DevX failure artifact paths. Start `pnpm dev:all` first.
- `pnpm smoke:repo-home` runs a focused browser check for the repository
  home/files page, including the visible SSH clone URL.
- `pnpm smoke:reader-parity` runs the broad seeded Coflat showcase
  reader/editor parity browser check, including outline labels, hover target
  selection, footnote sections, typography, and geometry.
- `pnpm check:pr-rich -- --list-fixtures` prints named rich-render fixtures.
  Built-ins are intentionally small aliases for known live regressions; add
  site-specific aliases with
  `COSHEAF_PR_RICH_FIXTURES='name=/owner/repo/pulls/1/files?file=a.md'`.
- `pnpm check:web:settings` runs only account/repository settings separation and
  prints DevX failure artifact paths. Start `pnpm dev:all` first.
- `pnpm dev:login-state` writes `.playwright/cosheaf-chao-state.json` for manual browser/debug scripts against `COSHEAF_WEB_URL` from `.env.dev` (default `http://localhost:3030`).

## Workbench Migration Gates

Local Workbench code is a local git workbench plus an optional remote Cosheaf
workspace server. Keep these checks in review for any Workbench, automation, or
publish-flow change:

- `pnpm check:no-forgejo-workbench` must stay mandatory in `pnpm check:lint`.
  It blocks `server/local/**` from naming the backing forge directly.
- Use typed Cosheaf routes or `OriginCollaborationClient` for remote workspace-server
  operations. Do not add raw backing-forge calls or hidden local issue/PR
  storage to the Workbench.
- For local PR/open-flow changes, run
  `pnpm exec vitest run server/local/local-pulls.test.ts server/local/local-app.test.ts server/local/origin-collaboration-client.test.ts server/local/origin-response.test.ts`.
  This covers local edit/commit/push/open-remote-PR behavior, connected and
  disconnected UI labels, and the Origin response parser contract.
- Hosted regressions still belong in the normal gates: `pnpm check:local` for
  static/unit/build coverage, plus `pnpm check:web` when login, files, issues,
  PR review/merge, notifications, or assets are affected.

## Staging

Staging is the normal live target for agents:

- Web: `https://cosheaf-test.lab`
- Host: `jupiter`
- Compose profile: `test`
- Data: isolated from production, including its own Forgejo backend

Use staging for almost all live verification:

```sh
pnpm staging:deploy
pnpm staging:verify
pnpm staging:e2e
pnpm staging:refs
```

For a full pre-merge/pre-release pass, use:

```sh
pnpm staging:gate
```

`staging:deploy` deploys the current committed `HEAD`; the commit must be
pushed to `origin` first so `jupiter` can fetch it. It refuses dirty local
trees because uncommitted changes cannot be represented on staging.
`staging:verify` has the same clean/pushed commit requirement. Use
`node scripts/staging-release.mjs health` when you only need to check that
staging is healthy and reports some non-unknown commit.

Keep the broad seeded reader/editor parity suite local (`pnpm
smoke:reader-parity`). Staging has persistent user data, so `staging:e2e` uses
stable live canaries rather than assuming every local fixture detail exists
there.

For targeted PR-rich validation, prefer:

```sh
pnpm staging:check-page -- /chao/flushing-coin/pulls/1/files?file=coflat-feature-showcase.md
pnpm staging:check-page -- milk-pr3-md
```

The checker writes screenshots under `test-results/page-rich-check/` and prints
the reader island's `documentRef`, `resourceRef`, and fallback refs. Those
provenance fields are the first place to look for stale-main bugs in citations,
cross-file refs, linked assets, and PDF/raw companion resources.

## Production

Production always means Pluto and has real users:

- Web: `https://cosheaf.chaoxu.prof`
- Git SSH: `ssh://git@cosheaf.chaoxu.prof:2223/<owner>/<repo>.git`
- Release helper: `fleet-infra/bin/cosheaf-pluto-release`

Use these repo-local commands:

```sh
pnpm prod:status
pnpm prod:verify
pnpm prod:repo-check
pnpm prod:build-check
pnpm prod:e2e -- prod
```

`pnpm prod:status` checks the deployed Cosheaf SHA and deployed Coflat ref
against this checkout. It still prints the local `../coflat` HEAD, but a local
Coflat mismatch is informational in `--prod` mode because production uses the
pinned release ref.

Production deploy is intentionally not part of the normal DevX path. Only run
it after the user explicitly asks for production deploy:

```sh
COSHEAF_CONFIRM_PROD_RELEASE=1 pnpm prod:release
```

`pnpm pluto:release`, `pnpm pluto:verify`, `pnpm pluto:repo-check`, and
`pnpm pluto:e2e` are equivalent aliases.

Useful overrides for `pnpm dev:login-state`:

```sh
COSHEAF_WEB_URL=http://localhost:3030 \
COSHEAF_DEV_USER=chao \
COSHEAF_DEV_PASSWORD='Cosheaf123!' \
COSHEAF_STORAGE_STATE=.playwright/cosheaf-chao-state.json \
pnpm dev:login-state
```

## Route-To-File Map

- Server-rendered web route assembly: `server/routes/web.ts`
  - Verify with `pnpm check:web` and `pnpm devx:verify-route`.
- Repository file/read/edit pages: `server/routes/web-files.ts`
  - Verify with `pnpm exec vitest run server/routes/web-files.test.ts`, `pnpm check:web`, and `pnpm devx:verify-route`.
- Branch and commit pages: `server/routes/web-branches.ts`
  - Verify with `pnpm exec vitest run server/routes/web-files.test.ts` and `pnpm devx:verify-route -- --route /chao/flushing-coin/branches`.
- PDF export pages: `server/routes/web-pdf-export.ts`
  - Verify with `pnpm exec vitest run server/routes/web-files.test.ts server/async-job-limiter.test.ts`.
- File links and file tree panels: `server/routes/web-file-links.ts`, `server/routes/web-file-tree.ts`
  - Verify with `pnpm exec vitest run server/routes/web-files.test.ts`.
- Server-rendered web CSS: `public/cosheaf-web.css`
  - Verify with `pnpm check:web` and `pnpm devx:verify-route -- --route /chao/flushing-coin/activity`.
- Static asset serving and route mounting: `server/app.ts`
  - Verify with `pnpm build`, `pnpm check:web`, and `pnpm devx:verify-route`.
- Page editor island: `src/cosheaf/web-editor.tsx`
  - Verify with `pnpm smoke:edit`, `pnpm smoke:reader-parity`, `pnpm build`, and `pnpm check:web`.
- Coflat reader island: `src/cosheaf/web-reader.ts`
  - Verify with `pnpm smoke:rendering`, `pnpm smoke:reader-parity`, and `pnpm check:web`.
- Coflat pin / package refresh: `scripts/check-coflat-ref.mjs`, `scripts/bump-coflat.mjs`, `scripts/refresh-coflat.mjs`
  - Verify with `pnpm coflat:status`, `pnpm refresh:coflat`, and `pnpm exec vitest run scripts/check-coflat-ref.test.mjs`.
- Page-island fetch helper: `src/cosheaf/api.ts`
  - Verify with `pnpm smoke:edit`, `pnpm check:web`, and route-specific unit tests.
- Typed files API: `server/routes/files.ts`
  - Verify with `pnpm exec vitest run server/routes/files.test.ts` and `pnpm smoke:api`.
- Typed pull request API: `server/routes/pulls.ts`
  - Verify with `pnpm exec vitest run server/routes/pulls.test.ts`, `pnpm check:web`, and `pnpm smoke:rendering`.
- Typed issues, labels, milestones, timeline, and activity API: `server/routes/issues.ts`
  - Verify with `pnpm exec vitest run server/routes/issues.test.ts`, `pnpm check:web`, and `pnpm smoke:issues`.
- Activity feed normalization/collapse helpers: `server/activity-feed.ts`
  - Verify with `pnpm exec vitest run server/routes/issues.test.ts`, `pnpm check:web`, and `pnpm devx:verify-route -- --route /chao/flushing-coin/activity`.
- Forgejo client: `server/forgejo.ts`
  - Verify with the affected route unit tests plus `pnpm smoke:api`.
- Shared issue/activity DTOs: `shared/issues.ts`
  - Verify with `pnpm exec vitest run server/routes/issues.test.ts` and `pnpm check:web`.
- E2E web flow: `tests/e2e/web-pages.spec.ts`
  - Verify with `pnpm check:web`.
- Focused settings E2E: `tests/e2e/web-settings.spec.ts`
  - Verify with `pnpm check:web:settings`.

## Common Issue Templates

Forgejo templates live in `.gitea/ISSUE_TEMPLATE/`:

- `rendering-parity.md`
- `web-ui-regression.md`
- `api-contract.md`
- `devx-cleanup.md`
