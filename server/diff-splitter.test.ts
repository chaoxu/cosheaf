import { describe, it, expect } from "vitest";
import { splitUnifiedDiff } from "./diff-splitter.js";

describe("splitUnifiedDiff", () => {
  it("returns empty for empty input", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
  });

  it("returns empty when no diff headers present", () => {
    expect(splitUnifiedDiff("just some text\nno diff here")).toEqual([]);
  });

  it("splits a single-file modify diff", () => {
    const input = [
      "diff --git a/hello.md b/hello.md",
      "index abc..def 100644",
      "--- a/hello.md",
      "+++ b/hello.md",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " context",
      "",
    ].join("\n");

    const out = splitUnifiedDiff(input);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("hello.md");
    expect(out[0].previous_path).toBeUndefined();
    expect(out[0].patch.startsWith("diff --git")).toBe(true);
    expect(out[0].patch.endsWith(" context")).toBe(true);
  });

  it("splits a multi-file diff into separate patches", () => {
    const input = [
      "diff --git a/a.md b/a.md",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1 +1 @@",
      "-A",
      "+A!",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1 @@",
      "-B",
      "+B!",
    ].join("\n");

    const out = splitUnifiedDiff(input);
    expect(out.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(out[0].patch.includes("a.md")).toBe(true);
    expect(out[0].patch.includes("b.md")).toBe(false);
    expect(out[1].patch.includes("b.md")).toBe(true);
  });

  it("recognizes added files (--- /dev/null)", () => {
    const input = [
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    const out = splitUnifiedDiff(input);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("new.md");
  });

  it("recognizes deleted files (+++ /dev/null)", () => {
    const input = [
      "diff --git a/gone.md b/gone.md",
      "deleted file mode 100644",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    const out = splitUnifiedDiff(input);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("gone.md");
  });

  it("captures previous_path for renames", () => {
    const input = [
      "diff --git a/old.md b/new.md",
      "similarity index 100%",
      "rename from old.md",
      "rename to new.md",
    ].join("\n");
    const out = splitUnifiedDiff(input);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("new.md");
    expect(out[0].previous_path).toBe("old.md");
  });
});
