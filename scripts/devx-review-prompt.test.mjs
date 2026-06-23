import { describe, expect, it } from "vitest";
import { reviewPrompt } from "./devx-review-prompt.mjs";

describe("devx review prompt", () => {
  it("packages pending work and verification notes", () => {
    const prompt = reviewPrompt({
      verification: "pnpm check:pre-push passed",
      summary: {
        upstream: "origin/main",
        clean: true,
        ahead: 1,
        commits: ["abc1234 Update DevX"],
        files: ["scripts/devx-pending.mjs"],
        suggestions: [{ run: "pnpm check:pre-push", reason: "pinned gate" }],
      },
    });
    expect(prompt).toContain("Commits ahead: 1");
    expect(prompt).toContain("- abc1234 Update DevX");
    expect(prompt).toContain("- scripts/devx-pending.mjs");
    expect(prompt).toContain("pnpm check:pre-push passed");
  });
});
