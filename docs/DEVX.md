# Cosheaf DevX

## Agent Entry Points

- `pnpm devx:ready` prepares a local agent workspace: checks Forgejo `3002`,
  runs the manual seed, starts `pnpm dev:all` if needed, writes Playwright login
  state, and prints route targets plus focused checks.
- `pnpm devx:what-to-run` inspects changed files and prints the smallest useful
  verification set. Pass explicit files to bypass git detection, or `--json`
  when another script should consume the result.
- `pnpm devx:verify-route` opens real browser pages and checks HTTP status,
  global-header scroll behavior, issue/PR filter visibility, asset 4xxs, and
  console errors. Defaults to the seeded activity/issues/pulls routes.
- `pnpm coflat:status` prints the pinned Coflat SHA, sibling checkout SHA,
  lockfile hash, and local Cosheaf SHA. Add `-- --prod` to also query the
  deployed production Cosheaf SHA on `jupiter`.
- `pnpm refresh:coflat` builds `../coflat`, installs with lifecycle scripts
  disabled, and rebuilds native packages. It avoids the local lefthook
  `core.hooksPath` failure that made the old refresh path unreliable.
- `pnpm verify:cogirth-outline` is an optional live canary for the active
  Cogirth editing target. It is not the standard parity gate; use the seeded
  `pnpm smoke:reader-parity` fixture for durable outline/hover regressions.

## Fast Checks

- `pnpm check:local` runs the normal local gate: static checks, unit tests, Vite build, and server build.
- `pnpm check:web:fast` runs the smaller server-rendered UI gate for low-risk
  markup/CSS changes: types, focused web route tests, Vite build, and server
  build.
- `pnpm check:web` runs the full server-rendered web page flow and prints
  DevX failure artifact paths. Start `pnpm dev:all` first.
- `pnpm smoke:repo-home` runs a focused browser check for the repository
  home/files page, including the visible SSH clone URL.
- `pnpm smoke:reader-parity` runs the broad seeded Coflat showcase
  reader/editor parity browser check, including outline labels, hover target
  selection, typography, and geometry.
- `pnpm check:web:settings` runs only account/repository settings separation and
  prints DevX failure artifact paths. Start `pnpm dev:all` first.
- `pnpm dev:login-state` writes `.playwright/cosheaf-chao-state.json` for manual browser/debug scripts against `COSHEAF_WEB_URL` from `.env.dev` (default `http://localhost:3030`).

Useful overrides for `pnpm dev:login-state`:

```sh
COSHEAF_WEB_URL=http://localhost:3030 \
COSHEAF_DEV_USER=chao \
COSHEAF_DEV_PASSWORD='Cosheaf123!' \
COSHEAF_STORAGE_STATE=.playwright/cosheaf-chao-state.json \
pnpm dev:login-state
```

## Route-To-File Map

- Server-rendered web pages: `server/routes/web.ts`
  - Verify with `pnpm check:web` and `pnpm devx:verify-route`.
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
  - Verify with `pnpm test -- server/routes/issues.test.ts` and `pnpm check:web`.
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
