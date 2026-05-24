# Cosheaf DevX

## Fast Checks

- `pnpm check:local` runs the normal local gate: static checks, unit tests, and production build.
- `pnpm check:web` runs the full server-rendered web page flow. Start `pnpm dev:all` first.
- `pnpm check:web:settings` runs only account/project settings separation. Start `pnpm dev:all` first.
- `pnpm dev:login-state` writes `.playwright/cosheaf-chao-state.json` for manual browser/debug scripts against `http://localhost:3030`.

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
- Server-rendered web CSS: `public/cosheaf-web.css`
- Static asset serving and ownerless route rewrite: `server/index.ts`
- Page editor island: `src/cosheaf/web-editor.tsx`
- Legacy SPA shell: `src/cosheaf/app.tsx`
- SPA project settings panel: `src/cosheaf/review/SettingsPanel.tsx`
- Typed files API: `server/routes/files.ts`
- Typed pull request API: `server/routes/pulls.ts`
- Typed issues, labels, milestones, timeline, and activity API: `server/routes/issues.ts`
- Activity feed normalization/collapse helpers: `server/activity-feed.ts`
- Forgejo client: `server/forgejo.ts`
- Shared issue/activity DTOs: `shared/issues.ts`
- E2E web flow: `tests/e2e/web-pages.spec.ts`
- Focused settings E2E: `tests/e2e/web-settings.spec.ts`

## Jupiter

- Release prod on `jupiter`: `pnpm jupiter:release`
- Verify prod on `jupiter`: `pnpm jupiter:verify`
- Live URL: `https://cosheaf.lab`
- Prod container: `cosheaf-prod`
- Doctor command run by verify: `node dist-server/server/cli.js doctor`

Release only from `main`. The release script SSHes to `jupiter`, fast-forwards
`/home/chaoxu/playground/cosheaf`, rebuilds the Compose image, recreates
`cosheaf-prod`, waits for health, and prints the deployed git SHA.

## Common Issue Templates

Forgejo templates live in `.gitea/ISSUE_TEMPLATE/`:

- `rendering-parity.md`
- `web-ui-regression.md`
- `api-contract.md`
- `devx-cleanup.md`
