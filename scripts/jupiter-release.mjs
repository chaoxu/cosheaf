#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const environments = {
  prod: {
    profile: "prod",
    service: "cosheaf-prod",
    portEnv: "COSHEAF_PROD_PORT",
    defaultPort: "3030",
    publicUrl: "https://cosheaf.lab",
  },
};

function usage() {
  console.error("usage: node scripts/jupiter-release.mjs <deploy|verify|release|doctor|health|host-doctor> <prod>");
  process.exit(2);
}

const [action, envName] = process.argv.slice(2).filter((arg) => arg !== "--");
const env = environments[envName];
if (!action || !env) usage();

const port = process.env[env.portEnv] ?? env.defaultPort;

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function tryOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function containerEnv(name) {
  return output("docker", ["exec", env.service, "sh", "-c", `printenv ${name} || true`]) || "unknown";
}

function deploy() {
  const commit = process.env.COSHEAF_GIT_SHA || tryOutput("git", ["rev-parse", "HEAD"]) || "unknown";
  run("node", ["scripts/prepare-coflat-editor-package.mjs"]);
  run("docker", [
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
  run("docker", ["logs", env.service, "--tail", "100"]);
  process.exit(1);
}

function doctor() {
  run("docker", [
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
  run("docker", ["exec", "forgejo-cosheaf", "wget", "-qO-", webhookUrl.replace("/api/v1/webhooks/forgejo", "/api/v1/health")]);
  run("sudo", ["-n", "/usr/bin/caddy", "validate", "--config", "/etc/caddy/Caddyfile"]);
}

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
  default:
    usage();
}
