#!/usr/bin/env node

import { parseArgs } from "node:util";
import { output, run } from "./lib/run.mjs";

const stagingHost = process.env.COSHEAF_STAGING_HOST ?? "jupiter";
const stagingUrl = process.env.COSHEAF_STAGING_URL ?? "https://cosheaf-test.lab/";
const stagingCheckout = process.env.COSHEAF_STAGING_CHECKOUT;
const COFLAT_GIT_REPO = process.env.COFLAT_GIT_REPO ?? "https://gitea.lab/chaoxu/coflat.git";
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
  // Coflat is unpinned: resolve its current main SHA and pass it as
  // COFLAT_GIT_REF so the Docker build's coflat-fetch layer cache-busts whenever
  // coflat advances. Otherwise a constant COFLAT_GIT_REF=main key reuses a stale
  // coflat layer and staging silently runs an old editor.
  const script = `
set -euo pipefail
cd ${remoteCheckoutExpr()}
git fetch --all --prune
git checkout ${shellQuote(sha)}
coflat_ref="$(git -c http.sslVerify=false ls-remote ${shellQuote(COFLAT_GIT_REPO)} refs/heads/main 2>/dev/null | cut -f1)"
if [ -z "$coflat_ref" ]; then echo "could not resolve coflat main SHA"; exit 1; fi
health="$(curl -fsS http://127.0.0.1:3031/api/v1/health 2>/dev/null || true)"
parse() { printf '%s' "$health" | node -e "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{try{console.log(JSON.parse(b).$1||'')}catch{console.log('')}})"; }
current_sha="$(parse commit)"
current_coflat="$(parse coflat_ref)"
if [ "$current_sha" = ${shellQuote(sha)} ] && [ "$current_coflat" = "$coflat_ref" ]; then
  echo "staging already running ${sha} on coflat $coflat_ref; skipping deploy"
  exit 0
fi
echo "deploying ${sha} against coflat $coflat_ref"
sudo -n env COSHEAF_GIT_SHA=${shellQuote(sha)} COFLAT_GIT_REF="$coflat_ref" docker compose --profile test up -d --build
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
