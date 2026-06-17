import { describe, expect, it } from "vitest";
import { suggestChecks } from "./devx-what-to-run.mjs";

describe("devx check suggestions", () => {
  it("maps web CSS changes to browser route checks", () => {
    const result = suggestChecks(["public/cosheaf-web.css"]);
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
  });

  it("maps dev URL helper changes to env normalization tests", () => {
    const result = suggestChecks(["scripts/lib/env-dev.mjs", "server/vite-dev-origin.ts"]);
    expect(result.matchedRules).toContain("devx");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm exec vitest run scripts/devx.test.mjs scripts/browser-utils.test.mjs server/vite-dev-origin.test.ts server/vite-config.test.ts",
    );
  });
});
