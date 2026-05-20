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

Set `COSHEAF_FORGEJO_URL` to the Forgejo URL reachable from inside the
container. Use the public Cosheaf URL for `COSHEAF_SERVER_URL` and
`COSHEAF_WEBHOOK_URL`.

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
