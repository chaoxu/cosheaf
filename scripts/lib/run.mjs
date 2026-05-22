import { spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : options.input ? ["pipe", "inherit", "inherit"] : "inherit",
    shell: false,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  return options.capture ? result.stdout.trim() : "";
}

export function output(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

export function tryOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: false,
    ...options,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

