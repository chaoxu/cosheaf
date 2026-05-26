import { describe, expect, it } from "vitest";
import { suggestChecks } from "./devx-what-to-run.mjs";

describe("devx check suggestions", () => {
  it("maps web CSS changes to browser route checks", () => {
    const result = suggestChecks(["public/cosheaf-web.css"]);
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm check:web");
    expect(result.suggestions.map((item) => item.run)).toContain(
      "pnpm devx:verify-route -- --route /flushing-coin/activity",
    );
  });

  it("maps issue route changes to issue unit and browser checks", () => {
    const result = suggestChecks(["server/routes/issues.ts"]);
    expect(result.matchedRules).toContain("issues");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm exec vitest run server/routes/issues.test.ts");
    expect(result.suggestions.map((item) => item.run)).toContain("pnpm smoke:issues");
  });
});
