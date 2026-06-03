import { describe, expect, it } from "vitest";
import { checkCoflatRef, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

describe("checkCoflatRef", () => {
  it("accepts the pinned Coflat revision", () => {
    const result = checkCoflatRef({
      coflatDir: ".",
      execFile: () => `${DEFAULT_COFLAT_REF}\n`,
    });
    expect(result).toEqual({ ok: true, actualRef: DEFAULT_COFLAT_REF });
  });

  it("rejects a mismatched sibling checkout", () => {
    const result = checkCoflatRef({
      coflatDir: ".",
      expectedRef: "expected",
      execFile: () => "actual\n",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected expected");
  });

  it("reports a non-git sibling checkout", () => {
    const result = checkCoflatRef({
      coflatDir: ".",
      execFile: () => {
        throw new Error("not a git repo");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("could not read Coflat git revision");
  });
});
