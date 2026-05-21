# Deploy on jupiter

`jupiter` is the container host for production and branch testing. Build
Cosheaf from `/Users/chaoxu/playground` or `~/playground`, because the Docker
image needs both `cosheaf` and the sibling `coflat-editor` package.

## Environment model

Cosheaf uses three environment shapes:

- **testing**: disposable branch previews. A non-`main` branch gets its own
  container, SQLite volume, and HTTPS `.lab` route.
- **staging**: optional long-lived rehearsal. Use this when a change needs a
  realistic dry run before prod. For the current Cosheaf setup, staging may use
  the same Forgejo backend and can be skipped for small changes.
- **prod**: the user-facing app at `https://cosheaf.lab`.

Testing should be cheap and disposable. Staging should be close to prod when it
is used. Prod should only receive code that already passed the relevant browser
and container checks.

## Environment files

Compose reads env files from `/srv/cosheaf` by default:

```sh
/srv/cosheaf/.env.prod
/srv/cosheaf/.env.staging
/srv/cosheaf/.env.testing
```

Create them from `.env.deploy.example`. Do not keep authoritative secrets in
the repo checkout. To use a different env directory, set `COSHEAF_ENV_DIR` when
running Compose or `scripts/jupiter-release.mjs`.

Cosheaf uses its own Forgejo instance, separate from the general-purpose Gitea
service on `jupiter:3001`. On `jupiter`, the Cosheaf Forgejo container listens
on `100.93.22.80:3002`, so deployments should use:

```sh
COSHEAF_FORGEJO_URL=http://100.93.22.80:3002
```

Use the public HTTPS `.lab` URL for `COSHEAF_SERVER_URL`. Use a direct
Jupiter/Tailscale HTTP URL for `COSHEAF_WEBHOOK_URL`, because the Forgejo
container does not resolve or trust the browser-facing `.lab` hostname.

For prod:

```sh
COSHEAF_SERVER_URL=https://cosheaf.lab
COSHEAF_WEBHOOK_URL=http://100.93.22.80:3030/api/v1/webhooks/forgejo
```

## Forgejo backend

The Cosheaf Forgejo data lives under `/srv/forgejo/data` on `jupiter`, with its
Compose file at `/srv/forgejo/compose/docker-compose.yml`. A copy of the
service shape is tracked in `deploy/jupiter/forgejo-compose.yaml`.

Start or restart the Forgejo backend on `jupiter` with:

```sh
cd /srv/forgejo/compose
docker compose up -d
```

Do not point Cosheaf at the general-purpose Gitea service on port `3001`.

## Deploy and verify

From the `cosheaf` repo on `jupiter`:

```sh
pnpm jupiter:release -- prod
pnpm jupiter:verify -- prod
```

`release` builds/recreates the container and checks HTTP health. `verify` runs
health plus `pnpm cli doctor` inside the container. Doctor is stricter: on a
fresh sidecar volume it may report missing recent webhook deliveries until a
real Forgejo event has arrived.

For host-level checks on `jupiter`, run:

```sh
pnpm jupiter:host-doctor -- prod
```

This uses Docker, Caddy, curl, and Forgejo's container to verify the public URL,
direct webhook URL, deployed commit, Caddy config, and local health endpoint.
The `/api/v1/health` response includes the deployed commit:

```json
{ "ok": true, "commit": "..." }
```

For browser checks from a machine with Playwright installed, run:

```sh
pnpm jupiter:e2e -- prod
pnpm jupiter:e2e -- staging
pnpm jupiter:e2e -- https://cosheaf-my-branch.lab
```

By default this runs non-destructive login/page and issue-navigation checks.
Add `--destructive` to also run branch-merge and review-merge flows, which
create and merge test files/PRs.

The direct container ports are:

- production: `3030`
- staging: `3031`
- testing: `3032`

Override them with `COSHEAF_PROD_PORT`, `COSHEAF_STAGING_PORT`, or
`COSHEAF_TESTING_PORT`.

Each long-lived environment has its own SQLite sidecar volume:

- `cosheaf-prod-data`
- `cosheaf-staging-data`
- `cosheaf-testing-data`

Forgejo remains the source of truth. If webhooks were down or repository
content was changed outside Cosheaf, rebuild an environment's sidecar index
inside that container:

```sh
docker compose --profile prod exec cosheaf-prod \
  node dist-server/server/cli.js workspace reindex <slug>
```

## Branch previews

Non-`main` branch pushes run `.gitea/workflows/preview.yml` on `jupiter`. The
workflow builds the branch image, starts an isolated container named
`cosheaf-preview-<branch-slug>`, gives it its own SQLite volume, and exposes it
through Caddy as:

```text
https://cosheaf-<branch-slug>.lab
```

Preview containers use `/srv/cosheaf/.env.staging` as their base Forgejo
credentials, override their public server URL to the preview hostname, and use a
direct `100.93.22.80:<port>` webhook URL.

When a branch is deleted, `.gitea/workflows/preview-cleanup.yml` removes the
preview container, image, Caddy snippet, and SQLite volume. It can also be run
manually for a named branch.

Preview helper commands on `jupiter`:

```sh
pnpm jupiter:preview -- url my-branch
pnpm jupiter:preview -- list
pnpm jupiter:preview -- clean my-branch
```

## Promotion flow

Use this default flow for larger changes:

1. Push a branch and inspect its testing preview.
2. Run browser smoke tests against the preview or staging.
3. Merge to `main`.
4. Deploy prod from the same commit.
5. Run prod health and a small browser smoke.

Use long-lived staging only when the change needs a realistic rehearsal before
prod. For small UI fixes, a branch preview plus prod smoke is enough.
