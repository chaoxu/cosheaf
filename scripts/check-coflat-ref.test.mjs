import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpCoflat } from "./bump-coflat.mjs";
import { checkCoflatRef, checkDocPins, DEFAULT_COFLAT_REF } from "./check-coflat-ref.mjs";

const hex = (c) => c.repeat(40);

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

describe("checkDocPins", () => {
  it("flags a doc whose pin differs from the expected ref", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["README.md", "AGENTS.md"],
      readFile: (p) => (p.endsWith("README.md") ? `git -C coflat checkout ${hex("b")}` : `git -C coflat checkout ${hex("a")}`),
    });
    expect(drifted).toEqual([{ file: "README.md", found: hex("b") }]);
  });

  it("passes when every doc pin matches", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      readFile: () => `git -C coflat checkout ${hex("a")}`,
    });
    expect(drifted).toEqual([]);
  });

  it("skips docs that cannot be read", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(drifted).toEqual([]);
  });

  it("keeps the live README and AGENTS pins in sync with DEFAULT_COFLAT_REF", () => {
    // Regression guard for the real drift that shipped once: README pinned an
    // older SHA than the checker. With repoRoot defaulted to the script's repo
    // root, this reads the actual README.md/AGENTS.md.
    expect(checkDocPins()).toEqual([]);
  });
});

describe("bumpCoflat", () => {
  it("rewrites the pin across the checker, README, and AGENTS", () => {
    const root = mkdtempSync(join(tmpdir(), "bump-coflat-"));
    const old = hex("a");
    const next = hex("c");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/check-coflat-ref.mjs"), `export const DEFAULT_COFLAT_REF = "${old}";\n`);
    writeFileSync(join(root, "README.md"), `prose\ngit -C coflat checkout ${old}\nmore\n`);
    writeFileSync(join(root, "AGENTS.md"), `git -C coflat checkout ${old}\n`);

    const updated = bumpCoflat({ sha: next, repoRoot: root });

    expect([...updated].sort()).toEqual(["AGENTS.md", "README.md", "scripts/check-coflat-ref.mjs"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`checkout ${next}`);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(`checkout ${next}`);
    expect(readFileSync(join(root, "scripts/check-coflat-ref.mjs"), "utf8")).toContain(`"${next}"`);
  });

  it("rejects a non-hex sha", () => {
    expect(() => bumpCoflat({ sha: "nope", repoRoot: "/tmp" })).toThrow(/40-hex/);
  });
});
