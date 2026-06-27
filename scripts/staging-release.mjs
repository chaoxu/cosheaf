#!/usr/bin/env node

import { parseArgs } from "node:util";
import { output, run } from "./lib/run.mjs";

const stagingHost = process.env.COSHEAF_STAGING_HOST ?? "jupiter";
const stagingUrl = process.env.COSHEAF_STAGING_URL ?? "https://cosheaf-test.lab/";
const stagingCheckout = process.env.COSHEAF_STAGING_CHECKOUT;
const actions = new Set(["deploy", "verify", "health", "gate"]);

const { positionals } = parseArgs({ allowPositionals: true });
const [action = "verify", explicitSha] = positionals;

if (!actions.has(action)) {
  console.error(`usage: staging-release <${[...actions].join("|")}> [sha]`);
  console.error("staging deploys target jupiter: https://cosheaf-test.lab");
  process.exit(2);
}

if (action === "gate") {
  const sha = resolveSha(explicitSha);
  run("pnpm", ["check:local"]);
  deploy(sha);
  await verify(sha);
  run("pnpm", ["staging:e2e"]);
} else if (action === "deploy") {
  deploy(resolveSha(explicitSha));
} else if (action === "verify") {
  await verify(resolveExpectedShaForVerify(explicitSha));
} else {
  await verify(explicitSha);
}

function resolveSha(value) {
  if (value) return value;
  const dirty = output("git", ["status", "--porcelain"], { allowFailure: false });
  if (dirty) {
    console.error("staging deploy uses committed code only; commit or stash local changes first.");
    process.exit(1);
  }
  const sha = output("git", ["rev-parse", "HEAD"]);
  const remoteRefs = output("git", ["branch", "-r", "--contains", sha], { allowFailure: true });
  if (!remoteRefs.trim()) {
    console.error(`staging deploy needs ${sha} pushed to origin so jupiter can fetch it.`);
    process.exit(1);
  }
  return sha;
}

function resolveExpectedShaForVerify(value) {
  if (value) return value;
  const dirty = output("git", ["status", "--porcelain"], { allowFailure: false });
  if (dirty) return undefined;
  const sha = output("git", ["rev-parse", "HEAD"]);
  const remoteRefs = output("git", ["branch", "-r", "--contains", sha], { allowFailure: true });
  return remoteRefs.trim() ? sha : undefined;
}

function deploy(sha) {
  const script = `
set -euo pipefail
cd ${remoteCheckoutExpr()}
git fetch --all --prune
git checkout ${shellQuote(sha)}
current_sha="$(curl -fsS http://127.0.0.1:3031/api/v1/health 2>/dev/null | node -e "let body=''; process.stdin.on('data', d => body += d); process.stdin.on('end', () => { try { console.log(JSON.parse(body).commit || ''); } catch { console.log(''); } });" || true)"
if [ "$current_sha" = ${shellQuote(sha)} ]; then
  echo "staging already running ${sha}; skipping deploy"
  exit 0
fi
image_sha="$(docker image inspect cosheaf-test:local --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | awk -F= '$1 == "COSHEAF_GIT_SHA" { print $2; exit }' || true)"
if [ "$image_sha" = ${shellQuote(sha)} ]; then
  echo "reusing existing cosheaf-test:local image for ${sha}"
  sudo -n env COSHEAF_GIT_SHA=${shellQuote(sha)} docker compose --profile test up -d --no-build --force-recreate cosheaf-test
else
  sudo -n env COSHEAF_GIT_SHA=${shellQuote(sha)} docker compose --profile test up -d --build
fi
`;
  run("ssh", [stagingHost, "bash -s"], { input: script });
}

function remoteCheckoutExpr() {
  return stagingCheckout ? shellQuote(stagingCheckout) : '"$HOME/playground/cosheaf"';
}

async function verify(expectedSha) {
  const healthUrl = new URL("/api/v1/health", stagingUrl).toString();
  const health = fetchJson(healthUrl);
  if (!health.ok) {
    console.error(`staging health failed: ${JSON.stringify(health)}`);
    process.exit(1);
  }
  if (health.commit === "unknown") {
    console.error(`staging health is missing COSHEAF_GIT_SHA: ${JSON.stringify(health)}`);
    process.exit(1);
  }
  if (expectedSha && health.commit !== expectedSha) {
    console.error(`staging commit mismatch: expected ${expectedSha}, got ${health.commit}`);
    process.exit(1);
  }
  console.log(`staging OK ${stagingUrl} commit=${health.commit} coflat=${health.coflat_ref}`);
}

function fetchJson(url) {
  let body;
  try {
    body = output("curl", ["-fsS", url]);
  } catch (err) {
    console.error(`cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    return JSON.parse(body);
  } catch (_err) {
    console.error(`${url} did not return JSON: ${body}`);
    process.exit(1);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
