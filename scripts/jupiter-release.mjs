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
  staging: {
    profile: "staging",
    service: "cosheaf-staging",
    portEnv: "COSHEAF_STAGING_PORT",
    defaultPort: "3031",
    publicUrl: null,
  },
  testing: {
    profile: "testing",
    service: "cosheaf-testing",
    portEnv: "COSHEAF_TESTING_PORT",
    defaultPort: "3032",
    publicUrl: null,
  },
};

function usage() {
  console.error("usage: node scripts/jupiter-release.mjs <deploy|verify|release|doctor|health> <prod|staging|testing>");
  process.exit(2);
}

const [action, envName] = process.argv.slice(2);
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

function deploy() {
  run("docker", [
    "compose",
    "--profile",
    env.profile,
    "up",
    "-d",
    "--build",
    "--force-recreate",
    env.service,
  ]);
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
  const urls = output("docker", ["exec", env.service, "printenv", "COSHEAF_SERVER_URL", "COSHEAF_WEBHOOK_URL"]);
  console.log(urls);
}

switch (action) {
  case "deploy":
    deploy();
    show();
    break;
  case "health":
    health();
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
