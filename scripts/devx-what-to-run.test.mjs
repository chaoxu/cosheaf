import { describe, expect, it } from "vitest";
import { changedFiles, suggestChecks } from "./devx-what-to-run.mjs";

describe("devx check suggestions", () => {
  it("maps web CSS changes to browser route checks", () => {
    const result = suggestChecks(["public/cosheaf-web.css"]);
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm check:web:fast");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm check:web");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm devx:verify-route -- --route /chao/flushing-coin/activity",
    );
  });

  it("maps issue route changes to issue unit and browser checks", () => {
    const result = suggestChecks(["server/routes/issues.ts"]);
    expect(result.matchedRules).toContain("issues");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm exec vitest run server/routes/issues.test.ts");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm smoke:issues");
  });

  it("maps app assembly changes to focused app and asset wiring tests", () => {
    const result = suggestChecks(["server/app.ts"]);
    expect(result.matchedRules).toContain("web-shell");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm exec vitest run server/app.test.ts server/static-assets.test.ts server/routes/web-shell.test.ts",
    );
  });

  it("maps API CSRF and auth changes to focused auth tests", () => {
    const result = suggestChecks(["server/api-csrf.ts"]);
    expect(result.matchedRules).toContain("auth-csrf");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm exec vitest run server/api-csrf.test.ts server/routes/auth.test.ts server/routes/web-context.test.ts",
    );
  });

  it("maps web file route changes to route and editor API tests", () => {
    const result = suggestChecks(["server/routes/web-files.ts"]);
    expect(result.matchedRules).toContain("editor");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm exec vitest run server/routes/web-files.test.ts src/cosheaf/api.test.ts",
    );
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm smoke:repo-home");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm smoke:reader-parity");
  });

  it("maps parity docs and Coflat tooling to parity-specific checks", () => {
    const result = suggestChecks(["docs/reader-editor-parity.md", "scripts/coflat-status.mjs"]);
    expect(result.matchedRules).toContain("coflat-parity");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm coflat:status");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm smoke:reader-parity");
    expect(result.suggestions.map((item) => item.run)).not.toContain("pnpm verify:cogirth-outline");
  });

  it("maps dev URL helper changes to env normalization tests", () => {
    const result = suggestChecks(["scripts/lib/env-dev.mjs", "server/vite-dev-origin.ts"]);
    expect(result.matchedRules).toContain("devx");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm exec vitest run scripts/devx.test.mjs scripts/browser-utils.test.mjs server/vite-dev-origin.test.ts server/vite-config.test.ts",
    );
  });
});

describe("changed file detection", () => {
  it("uses dirty working tree files before unpushed commits", () => {
    const seen = [];
    const files = changedFiles(null, (args) => {
      seen.push(args.join(" "));
      if (args.join(" ") === "diff --name-only HEAD") return ["server/routes/web-files.ts"];
      if (args.join(" ") === "diff --name-only --cached") return ["server/routes/web-pulls.ts"];
      return [];
    }, () => "origin/main");
    expect(files).toEqual(["server/routes/web-files.ts", "server/routes/web-pulls.ts"]);
    expect(seen).not.toContain("diff --name-only origin/main...HEAD");
  });

  it("uses unpushed commits when the working tree is clean", () => {
    const files = changedFiles(null, (args) => {
      if (args.join(" ") === "log --oneline origin/main..HEAD") return ["abc1234 Update"];
      if (args.join(" ") === "diff --name-only origin/main...HEAD") return ["scripts/pre-push-check.mjs"];
      return [];
    }, () => "origin/main");
    expect(files).toEqual(["scripts/pre-push-check.mjs"]);
  });

  it("does not report upstream-only changes when the branch is only behind", () => {
    const files = changedFiles(null, (args) => {
      if (args.join(" ") === "diff --name-only origin/main...HEAD") return ["server/routes/web-files.ts"];
      return [];
    }, () => "origin/main");
    expect(files).toEqual([]);
  });
});
