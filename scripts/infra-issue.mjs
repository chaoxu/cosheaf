#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Command } from "commander";

new Command("infra-issue")
  .description("file an infrastructure issue in chaoxu/fleet-infra")
  .requiredOption("--title <title>", "issue title")
  .option("--body <body>", "issue body")
  .option("--description <body>", "issue body alias")
  .action((opts) => {
    const body = opts.body ?? opts.description;
    if (!body) {
      console.error("error: required option '--body <body>' not specified");
      process.exit(1);
    }
    const result = spawnSync("tea", [
      "issues",
      "create",
      "--repo",
      "chaoxu/fleet-infra",
      "--title",
      opts.title,
      "--description",
      body,
    ], {
      stdio: "inherit",
      shell: false,
    });
    process.exit(result.status ?? 1);
  })
  .parse(process.argv);
