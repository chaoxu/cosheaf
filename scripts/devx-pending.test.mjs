import { describe, expect, it } from "vitest";
import { pendingSummary } from "./devx-pending.mjs";

describe("devx pending summary", () => {
  it("summarizes clean unpushed commits and suggested checks", () => {
    const summary = pendingSummary({
      upstream: "origin/main",
      gitFn: (args) => {
        const key = args.join(" ");
        if (key === "log --oneline origin/main..HEAD") return ["abc1234 Update DevX"];
        if (key === "diff --name-only origin/main...HEAD") return ["scripts/devx-what-to-run.mjs"];
        return [];
      },
    });
    expect(summary).toMatchObject({
      upstream: "origin/main",
      clean: true,
      ahead: 1,
      commits: ["abc1234 Update DevX"],
      files: ["scripts/devx-what-to-run.mjs"],
    });
    expect(summary.suggestions.map((item) => item.run)).toContain("pnpm exec vitest run scripts/devx-what-to-run.test.mjs");
  });

  it("uses dirty files before unpushed commit files", () => {
    const summary = pendingSummary({
      upstream: "origin/main",
      gitFn: (args) => {
        const key = args.join(" ");
        if (key === "diff --name-only HEAD") return ["server/routes/web-files.ts"];
        if (key === "log --oneline origin/main..HEAD") return ["abc1234 Update DevX"];
        if (key === "diff --name-only origin/main...HEAD") return ["scripts/devx-what-to-run.mjs"];
        return [];
      },
    });
    expect(summary.clean).toBe(false);
    expect(summary.files).toEqual(["server/routes/web-files.ts"]);
  });
});
