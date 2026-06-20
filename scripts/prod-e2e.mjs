#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { run } from "./lib/run.mjs";
import { smokeChecks } from "./smoke-manifest.mjs";

const explicitProdHost = process.env.COSHEAF_PROD_HOST;
const legacyProdHost = process.env.COSHEAF_JUPITER_HOST;
const prodHost = explicitProdHost ?? legacyProdHost ?? "root@cosheaf.chaoxu.prof";
const prodJump = process.env.COSHEAF_PROD_SSH_JUMP ?? "";
const prodUrl = process.env.COSHEAF_PROD_URL ?? "https://cosheaf.chaoxu.prof/";

function prodSshArgs(...args) {
  return [...(prodJump ? ["-J", prodJump] : []), prodHost, ...args];
}

const targets = {
  prod: {
    url: prodUrl,
    owner: process.env.COSHEAF_SMOKE_OWNER ?? "cosheaf-admin",
    workspace: process.env.COSHEAF_PROD_WORKSPACE ?? "poa-network-game",
    slug: process.env.COSHEAF_PROD_WORKSPACE_SLUG ?? "poa-network-game",
    page: process.env.COSHEAF_PROD_PAGE ?? "Price Of Anarchy Knowledge Base",
    pagePath: process.env.COSHEAF_PROD_PAGE_PATH ?? "index.md",
    prod: true,
  },
};

function targetFor(value) {
  return targets[value] ?? {
    url: value,
    owner: process.env.COSHEAF_SMOKE_OWNER ?? "chao",
    workspace: process.env.COSHEAF_SMOKE_WORKSPACE ?? "Flushing Coin",
    slug: process.env.COSHEAF_SMOKE_WORKSPACE_SLUG ?? "flushing-coin",
    page: process.env.COSHEAF_SMOKE_PAGE ?? "Hello",
    pagePath: process.env.COSHEAF_SMOKE_PAGE_PATH ?? "hello.md",
    prod: false,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function prodSmokePassword(target, username) {
  const provided = process.env.COSHEAF_SMOKE_PASSWORD;
  if (provided) return provided;
  const password = `CosheafSmoke-${randomBytes(18).toString("base64url")}!`;
  const script = `
SMOKE_USER=${shellQuote(username)}
SMOKE_PASSWORD=${shellQuote(password)}
SMOKE_OWNER=${shellQuote(target.owner)}
SMOKE_REPO=${shellQuote(target.slug)}
` + String.raw`
set -euo pipefail
if ! sudo -n test -r /srv/cosheaf/.env.prod; then
  echo "cannot read /srv/cosheaf/.env.prod on production host" >&2
  exit 1
fi
if ! sudo -n docker exec -u git forgejo-cosheaf forgejo admin user create \
    --username "$SMOKE_USER" \
    --password "$SMOKE_PASSWORD" \
    --email "$SMOKE_USER@cosheaf.chaoxu.prof" \
    --must-change-password=false >/dev/null 2>&1; then
  sudo -n docker exec -u git forgejo-cosheaf forgejo admin user change-password \
    --username "$SMOKE_USER" \
    --password "$SMOKE_PASSWORD" \
    --must-change-password=false >/dev/null
fi
admin_token="$(sudo -n awk -F= '/^COSHEAF_FORGEJO_ADMIN_TOKEN=/{print substr($0, index($0, "=")+1)}' /srv/cosheaf/.env.prod | tail -1)"
forge_url="$(sudo -n awk -F= '/^COSHEAF_FORGEJO_URL=/{print substr($0, index($0, "=")+1)}' /srv/cosheaf/.env.prod | tail -1)"
if [ -z "$forge_url" ]; then
  forge_url="http://127.0.0.1:3002"
fi
case "$forge_url" in
  http://forgejo:*|https://forgejo:*)
    forge_url="http://127.0.0.1:3002"
    ;;
esac
if [ -z "$admin_token" ]; then
  echo "COSHEAF_FORGEJO_ADMIN_TOKEN missing in /srv/cosheaf/.env.prod" >&2
  exit 1
fi
curl -fsS -X PUT \
  "$forge_url/api/v1/repos/$SMOKE_OWNER/$SMOKE_REPO/collaborators/$SMOKE_USER" \
  -H "Authorization: token $admin_token" \
  -H "content-type: application/json" \
  -d '{"permission":"write"}' >/dev/null
`;
  run("ssh", prodSshArgs("bash -s"), { input: script });
  console.log(`Provisioned production smoke user ${username} for ${target.owner}/${target.slug}`);
  return password;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { destructive: { type: "boolean", default: false } },
});
const targetArg = positionals[0];
if (!targetArg) {
  console.error("usage: prod-e2e <prod|url> [--destructive]");
  console.error("production defaults to Pluto at https://cosheaf.chaoxu.prof");
  console.error("set COSHEAF_PROD_HOST to override the production SSH host");
  console.error("set COSHEAF_PROD_SSH_JUMP to override the production SSH jump host");
  process.exit(2);
}
const target = targetFor(targetArg);
const destructive = values.destructive || process.env.COSHEAF_E2E_DESTRUCTIVE === "1";
const checks = smokeChecks.filter((check) => (!target.prod || check.prod) && (!check.destructive || destructive));
const grep = checks.map((check) => check.grep).join("|");
const username = process.env.COSHEAF_SMOKE_USER ?? (target.prod ? "cosheaf-smoke" : "chao");
const password = target.prod ? prodSmokePassword(target, username) : (process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!");
const childEnv = {
  ...process.env,
  URL: target.url,
  COSHEAF_SMOKE_USER: username,
  COSHEAF_SMOKE_PASSWORD: password,
  COSHEAF_SMOKE_OWNER: target.owner,
  COSHEAF_SMOKE_WORKSPACE: target.workspace,
  COSHEAF_SMOKE_WORKSPACE_SLUG: target.slug,
  COSHEAF_SMOKE_PAGE: target.page,
  COSHEAF_SMOKE_PAGE_PATH: target.pagePath,
};
if (!target.prod) {
  childEnv.COSHEAF_ADMIN_PASSWORD = process.env.COSHEAF_ADMIN_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
  childEnv.COSHEAF_MERI_PASSWORD = process.env.COSHEAF_MERI_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
  childEnv.COSHEAF_VERA_PASSWORD = process.env.COSHEAF_VERA_PASSWORD ?? process.env.COSHEAF_SMOKE_PASSWORD ?? "Cosheaf123!";
}
run("pnpm", ["exec", "playwright", "test", "--config", "playwright.smoke.config.ts", "--grep", grep], {
  env: childEnv,
});
console.log(`\nE2E checks passed for ${target.url}`);
