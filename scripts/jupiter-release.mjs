#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { output, run, tryOutput } from "./lib/run.mjs";

const environments = {
  prod: {
    profile: "prod",
    service: "cosheaf-prod",
    portEnv: "COSHEAF_PROD_PORT",
    defaultPort: "3030",
    publicUrl: "https://cosheaf.lab",
  },
};

const actions = ["deploy", "verify", "release", "doctor", "health", "host-doctor"];
const JUPITER_HOST = process.env.COSHEAF_JUPITER_HOST ?? "jupiter";
const JUPITER_CHECKOUT = process.env.COSHEAF_JUPITER_CHECKOUT ?? "/home/chaoxu/playground/cosheaf";
const host = hostIdentity();
let action = "";
let envName = "";
let env = null;
let port = "";

function hostIdentity() {
  try {
    return readFileSync("/etc/lab-host", "utf8").trim();
  } catch (_error) {
    return "unknown";
  }
}

function maybeDelegateToJupiter() {
  if (host === "jupiter" || process.env.COSHEAF_JUPITER_LOCAL === "1") return;
  const gitSync =
    action === "deploy" || action === "release"
      ? "git fetch origin main && git switch main && git pull --ff-only origin main && "
      : "";
  const remote = `cd ${shellQuote(JUPITER_CHECKOUT)} && ${gitSync}COSHEAF_JUPITER_LOCAL=1 node scripts/jupiter-release.mjs ${shellQuote(action)} ${shellQuote(envName)}`;
  run("ssh", [JUPITER_HOST, remote]);
  process.exit(0);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runDocker(args, options = {}) {
  const preserve = "COSHEAF_GIT_SHA,COSHEAF_ENV_DIR,COSHEAF_PROD_PORT,NPM_CONFIG_REGISTRY";
  if (host === "jupiter" && process.env.COSHEAF_DOCKER_NO_SUDO !== "1") {
    run("sudo", ["-n", `--preserve-env=${preserve}`, "docker", ...args], options);
    return;
  }
  run("docker", args, options);
}

function outputDocker(args) {
  const preserve = "COSHEAF_GIT_SHA,COSHEAF_ENV_DIR,COSHEAF_PROD_PORT,NPM_CONFIG_REGISTRY";
  if (host === "jupiter" && process.env.COSHEAF_DOCKER_NO_SUDO !== "1") {
    return output("sudo", ["-n", `--preserve-env=${preserve}`, "docker", ...args]);
  }
  return output("docker", args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireProdReleaseSource(commit) {
  if (envName !== "prod") return;
  if (process.env.COSHEAF_ALLOW_UNTRACKED_RELEASE === "1") return;
  if (!commit || commit === "unknown") {
    fail(
      "refusing prod release with unknown commit; run from a git checkout or set COSHEAF_GIT_SHA",
    );
  }

  const refName = process.env.GITHUB_REF_NAME || tryOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (refName && refName !== "main" && refName !== "HEAD") {
    fail(
      `refusing prod release from ${refName}; push the branch preview, merge to main, then release`,
    );
  }
}

function containerEnv(name) {
  return outputDocker(["exec", env.service, "sh", "-c", `printenv ${name} || true`]) || "unknown";
}

function deploy() {
  const commit = process.env.COSHEAF_GIT_SHA || tryOutput("git", ["rev-parse", "HEAD"]) || "unknown";
  requireProdReleaseSource(commit);
  runDocker([
    "compose",
    "--profile",
    env.profile,
    "up",
    "-d",
    "--build",
    "--force-recreate",
    env.service,
  ], { env: { ...process.env, COSHEAF_GIT_SHA: commit } });
}

function health() {
  for (let i = 1; i <= 60; i += 1) {
    const result = spawnSync("curl", ["-sf", `http://127.0.0.1:${port}/api/v1/health`], {
      stdio: "ignore",
      shell: false,
    });
    if (result.status === 0) {
      console.log(`${env.service} healthy after ${i}s`);
      if (env.publicUrl && process.env.JUPITER_CHECK_PUBLIC === "1") {
        run("curl", ["-sS", "-o", "/dev/null", "-w", "public https: http=%{http_code}\\n", `${env.publicUrl}/api/v1/health`]);
      }
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  runDocker(["logs", env.service, "--tail", "100"]);
  process.exit(1);
}

function doctor() {
  runDocker([
    "compose",
    "--profile",
    env.profile,
    "exec",
    "-T",
    env.service,
    "node",
    "dist-server/server/cli.js",
    "doctor",
  ]);
}

function verify() {
  health();
  doctor();
}

function release() {
  deploy();
  health();
}

function show() {
  console.log(containerEnv("COSHEAF_SERVER_URL"));
  console.log(containerEnv("COSHEAF_WEBHOOK_URL"));
  console.log(containerEnv("COSHEAF_GIT_SHA"));
}

function hostDoctor() {
  health();
  const serverUrl = containerEnv("COSHEAF_SERVER_URL");
  const webhookUrl = containerEnv("COSHEAF_WEBHOOK_URL");
  const commit = containerEnv("COSHEAF_GIT_SHA");
  console.log(`server=${serverUrl}`);
  console.log(`webhook=${webhookUrl}`);
  console.log(`commit=${commit}`);

  if (serverUrl.startsWith("https://")) {
    run("curl", ["-k", "-sS", "-o", "/dev/null", "-w", "public https: http=%{http_code}\\n", `${serverUrl}/api/v1/health`]);
  }
  if (webhookUrl.includes(".lab")) {
    console.error("webhook URL should be direct/reachable from Forgejo, not .lab");
    process.exit(1);
  }
  runDocker(["exec", "forgejo-cosheaf", "wget", "-qO-", webhookUrl.replace("/api/v1/webhooks/forgejo", "/api/v1/health")]);
  run("sudo", ["-n", "/usr/bin/caddy", "validate", "--config", "/etc/caddy/Caddyfile"]);
  run("curl", ["-sS", "-o", "/dev/null", "-w", "package registry: http=%{http_code}\\n", "http://packages.lab/api/packages/chaoxu/npm/"]);
  runDocker(["ps", "--filter", `name=${env.service}`, "--format", "container={{.Names}} status={{.Status}} image={{.Image}}"]);
  runDocker(["system", "df"]);
  run("df", ["-h", "/", "/srv"]);
}

function parseEnvironment(value) {
  const next = environments[value];
  if (!next) throw new InvalidArgumentError(`environment must be one of ${Object.keys(environments).join("|")}`);
  return value;
}

function parseAction(value) {
  if (!actions.includes(value)) throw new InvalidArgumentError(`action must be one of ${actions.join("|")}`);
  return value;
}

function dispatch() {
  switch (action) {
    case "deploy":
      deploy();
      show();
      break;
    case "health":
      health();
      break;
    case "host-doctor":
      hostDoctor();
      break;
    case "doctor":
      doctor();
      break;
    case "verify":
      verify();
      break;
    case "release":
      release();
      show();
      break;
  }
}

new Command("jupiter-release")
  .description("deploy and verify Cosheaf on jupiter")
  .argument("<action>", `one of ${actions.join("|")}`, parseAction)
  .argument("[environment]", `one of ${Object.keys(environments).join("|")}`, parseEnvironment, "prod")
  .action((actionArg, envArg) => {
    action = actionArg;
    envName = envArg;
    env = environments[envName];
    port = process.env[env.portEnv] ?? env.defaultPort;
    maybeDelegateToJupiter();
    dispatch();
  })
  .parse(process.argv);
