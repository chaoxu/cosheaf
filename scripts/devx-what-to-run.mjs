#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { Command } from "commander";

const rules = [
  {
    id: "web-shell",
    matches: [/^public\/cosheaf-web\.css$/, /^server\/routes\/web(?:-shell)?\.ts$/, /^server\/index\.ts$/, /^server\/app\.ts$/],
    commands: [
      command("pnpm exec vitest run server/app.test.ts server/static-assets.test.ts server/routes/web-shell.test.ts", "app assembly and server-rendered asset wiring"),
      command("pnpm check:web", "server-rendered route flow, browser behavior, assets"),
      command("pnpm devx:verify-route -- --route /chao/flushing-coin/activity", "real browser scroll/header check"),
    ],
  },
  {
    id: "auth-csrf",
    matches: [/^server\/api-csrf\.ts$/, /^server\/routes\/auth\.ts$/, /^server\/routes\/web-context\.ts$/],
    commands: [
      command("pnpm exec vitest run server/api-csrf.test.ts server/routes/auth.test.ts server/routes/web-context.test.ts", "cookie auth, login/logout, and same-origin mutation gates"),
      command("pnpm check:static", "types, lints, API contract, unused exports"),
    ],
  },
  {
    id: "issues",
    matches: [/^server\/routes\/issues\.ts$/, /^shared\/issues\.ts$/, /^server\/activity-feed\.ts$/],
    commands: [
      command("pnpm exec vitest run server/routes/issues.test.ts", "typed issue route unit coverage"),
      command("pnpm check:web", "issue filters, comments, state changes, activity route"),
      command("pnpm smoke:issues", "focused browser issue navigation smoke"),
    ],
  },
  {
    id: "pulls",
    matches: [/^server\/routes\/pulls\.ts$/, /^server\/diff-lines\.ts$/, /^src\/cosheaf\/web-reader\.ts$/],
    commands: [
      command("pnpm exec vitest run server/routes/pulls.test.ts", "typed pull/review route unit coverage"),
      command("pnpm check:web", "PR list, detail, files, review controls"),
      command("pnpm smoke:rendering", "long PR body and rich diff browser smoke"),
    ],
  },
  {
    id: "editor",
    matches: [/^server\/routes\/web-files\.ts$/, /^src\/cosheaf\/web-editor\.tsx$/, /^src\/cosheaf\/editor\.tsx$/, /^src\/cosheaf\/api\.ts$/],
    commands: [
      command("pnpm exec vitest run server/routes/web-files.test.ts src/cosheaf/api.test.ts", "web file route and editor API contract coverage"),
      command("pnpm smoke:edit", "server-rendered edit route and editor island"),
      command("pnpm build", "production Vite manifest and island assets"),
      command("pnpm check:web", "full page-owned editor path"),
    ],
  },
  {
    id: "settings",
    matches: [/settings/i],
    commands: [
      command("pnpm check:web:settings", "focused account/repository settings separation"),
      command("pnpm check:web", "settings within the full server-rendered flow"),
    ],
  },
  {
    id: "api-contract",
    matches: [/^docs\//, /^AGENTS\.md$/, /^server\/routes\/(?:files|branches|notifications|workspaces)\.ts$/],
    commands: [
      command("pnpm check:static", "types, lints, API contract, unused exports"),
      command("pnpm smoke:api", "typed agent/API route flow"),
    ],
  },
  {
    id: "deploy",
    matches: [/^Dockerfile$/, /^compose/],
    commands: [
      command("pnpm build", "container image and production asset inputs"),
      command("pnpm smoke", "browser smoke against the local fixture"),
    ],
  },
  {
    id: "devx",
    matches: [
      /^scripts\/devx-/,
      /^scripts\/web-route-check\.mjs$/,
      /^scripts\/playwright-devx\.mjs$/,
      /^scripts\/lib\/env-dev\.mjs$/,
      /^scripts\/browser-utils\.mjs$/,
      /^server\/vite-dev-origin\.ts$/,
      /^vite\.config\.ts$/,
      /^playwright\.smoke\.config\.ts$/,
      /^docs\/DEVX\.md$/,
    ],
    commands: [
      command("pnpm exec vitest run scripts/devx-what-to-run.test.mjs", "route-to-gate suggestion coverage"),
      command("pnpm exec vitest run scripts/devx.test.mjs scripts/browser-utils.test.mjs server/vite-dev-origin.test.ts server/vite-config.test.ts", "dev URL/env normalization coverage"),
      command("pnpm devx:what-to-run", "changed-file gate suggestions"),
      command("pnpm devx:verify-route -- --route /chao/flushing-coin/activity", "browser route checker sanity"),
    ],
  },
];

const baselineCommands = [
  command("pnpm check:local", "normal local gate: static checks, unit tests, Vite build, server build"),
];

function command(run, reason) {
  return { run, reason };
}

export function suggestChecks(files) {
  const normalized = [...new Set(files.map((file) => file.replace(/^\.\//, "")).filter(Boolean))].sort();
  const matchedRuleIds = new Set();
  const suggestions = [];

  for (const file of normalized) {
    for (const rule of rules) {
      if (rule.matches.some((pattern) => pattern.test(file))) {
        matchedRuleIds.add(rule.id);
        for (const cmd of rule.commands) addSuggestion(suggestions, cmd, file, rule.id);
      }
    }
  }

  if (suggestions.length === 0) {
    for (const cmd of baselineCommands) addSuggestion(suggestions, cmd, "(default)", "baseline");
  } else {
    addSuggestion(suggestions, baselineCommands[0], "(baseline)", "baseline");
  }

  return {
    files: normalized,
    matchedRules: [...matchedRuleIds].sort(),
    suggestions,
  };
}

function addSuggestion(suggestions, cmd, file, ruleId) {
  const existing = suggestions.find((item) => item.run === cmd.run);
  if (existing) {
    existing.files.push(file);
    if (!existing.rules.includes(ruleId)) existing.rules.push(ruleId);
    return;
  }
  suggestions.push({ ...cmd, files: [file], rules: [ruleId] });
}

function changedFiles(base) {
  if (base) return git(["diff", "--name-only", `${base}...HEAD`]);
  return [
    ...git(["diff", "--name-only", "HEAD"]),
    ...git(["diff", "--name-only", "--cached"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ];
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function printText(result) {
  if (result.files.length === 0) {
    console.log("No changed files detected; suggested baseline gate:");
  } else {
    console.log("Changed files:");
    for (const file of result.files) console.log(`  - ${file}`);
    console.log("\nSuggested checks:");
  }
  for (const item of result.suggestions) {
    console.log(`  - ${item.run}`);
    console.log(`    ${item.reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const program = new Command("devx-what-to-run")
    .option("--base <ref>", "compare committed changes against a base ref")
    .option("--json", "emit machine-readable JSON", false)
    .argument("[files...]", "explicit files instead of git-detected changes")
    .action((files, opts) => {
      const result = suggestChecks(files.length > 0 ? files : changedFiles(opts.base));
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printText(result);
    });
  program.parse(normalizeArgv(process.argv));
}

function normalizeArgv(argv) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}
