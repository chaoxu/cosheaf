# Deploy on jupiter

`jupiter` is the container host for production, staging, and testing. Build
Cosheaf from `/Users/chaoxu/playground` (the parent directory), because the
Docker image needs both `cosheaf` and the sibling `coflat-editor` package.

## Environment files

Create one env file per environment from `.env.deploy.example`:

```sh
cp .env.deploy.example .env.prod
cp .env.deploy.example .env.staging
cp .env.deploy.example .env.testing
```

Cosheaf uses its own Forgejo instance, separate from the general-purpose Gitea
service on `jupiter:3001`. On `jupiter`, the Cosheaf Forgejo container listens
on `100.93.22.80:3002`, so production should use:

```sh
COSHEAF_FORGEJO_URL=http://100.93.22.80:3002
```

Use the public HTTPS Cosheaf URL for `COSHEAF_SERVER_URL`. Use a direct
Jupiter/Tailscale HTTP URL for `COSHEAF_WEBHOOK_URL`, because the Forgejo
container does not resolve the browser-facing `.lab` hostname.

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

## Build and run

From the `cosheaf` repo on `jupiter`:

```sh
docker compose --profile prod up -d --build
docker compose --profile staging up -d --build
docker compose --profile testing up -d --build
```

The default host ports are:

- production: `3030`
- staging: `3031`
- testing: `3032`

Override them with `COSHEAF_PROD_PORT`, `COSHEAF_STAGING_PORT`, or
`COSHEAF_TESTING_PORT` when invoking Compose.

Each environment has its own SQLite sidecar volume:

- `cosheaf-prod-data`
- `cosheaf-staging-data`
- `cosheaf-testing-data`

Forgejo remains the source of truth. If webhooks were down or repository
content was changed outside Cosheaf, rebuild an environment's sidecar index
inside that container:

```sh
docker compose --profile staging exec cosheaf-staging \
  node dist-server/server/cli.js workspace reindex <slug>
```

## Branch Previews

Non-`main` branch pushes run `.gitea/workflows/preview.yml` on `jupiter`. The
workflow builds the branch image, starts an isolated container named
`cosheaf-preview-<branch-slug>`, gives it its own SQLite volume, and exposes it
through Caddy as:

```text
https://cosheaf-<branch-slug>.lab
```

The preview uses `/srv/cosheaf/.env.staging` for Forgejo credentials and talks
to the Cosheaf Forgejo backend on port `3002`. It should be used for branch
testing only; production remains the `prod` Compose profile.
