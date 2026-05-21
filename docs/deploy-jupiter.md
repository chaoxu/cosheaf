# Deploy on jupiter

`jupiter` is the container host for the production service and disposable
branch previews. Build Cosheaf from `/Users/chaoxu/playground/cosheaf` or
`~/playground/cosheaf`.

## Environment model

Cosheaf has one long-lived environment:

- **prod**: the user-facing app at `https://cosheaf.lab`.

Testing happens through disposable branch previews. A non-`main` branch can get
its own container, SQLite volume, and HTTPS `.lab` route. There is no separate
long-lived staging service for this project right now; keeping staging around
would mostly duplicate prod without buying much safety.

## Environment files

Compose reads env files from `/srv/cosheaf` by default:

```sh
/srv/cosheaf/.env.prod
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

Docker builds install `@chaoxu/coflat-editor` from the Jupiter Gitea npm
registry at `http://packages.lab/api/packages/chaoxu/npm/`. Production deploys
should use an explicit published package version from `package.json` /
`pnpm-lock.yaml`; do not rely on a sibling `../coflat-editor` checkout for
normal prod releases. Do not commit `jupiter:3001` or raw Jupiter IP package
registry URLs into `.npmrc` or the lockfile.

When testing unpublished editor changes, use a local Cosheaf worktree and a
temporary package-manager override. Publish a new editor patch version before
promoting those changes to Jupiter prod.

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
pnpm jupiter:e2e -- https://cosheaf-my-branch.lab
```

By default this runs non-destructive login/page, issue-navigation, and seeded
Markdown rendering checks for long-form issue and PR bodies.
Add `--destructive` to also run branch-merge and review-merge flows, which
create and merge test files/PRs.

The direct container ports are:

- production: `3030`

Override it with `COSHEAF_PROD_PORT`.

The long-lived environment has one SQLite sidecar volume:

- `cosheaf-prod-data`

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

Preview containers should use their own preview env file or generated env at
runtime, override their public server URL to the preview hostname, and use a
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

1. Push a branch and inspect its disposable preview.
2. Run browser smoke tests against the preview.
3. Merge to `main`.
4. Deploy prod from the same commit.
5. Run prod health and a small browser smoke.

`scripts/jupiter-release.mjs` enforces the production side of this path: prod
release refuses to run with an unknown commit, and refuses to deploy from a
non-`main` branch unless `COSHEAF_ALLOW_UNTRACKED_RELEASE=1` is set for an
explicit emergency override. The normal way to test a bug fix before prod is
to push the branch and use its generated `https://cosheaf-<branch>.lab`
preview.
