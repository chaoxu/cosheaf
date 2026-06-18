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

  it("treats a blank COFLAT_REF env override as unset", () => {
    const previous = process.env.COFLAT_REF;
    process.env.COFLAT_REF = "  ";
    try {
      const result = checkCoflatRef({
        coflatDir: ".",
        execFile: () => `${DEFAULT_COFLAT_REF}\n`,
      });
      expect(result).toEqual({ ok: true, actualRef: DEFAULT_COFLAT_REF });
    } finally {
      if (previous === undefined) delete process.env.COFLAT_REF;
      else process.env.COFLAT_REF = previous;
    }
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

  it("passes when every pin matches", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      readFile: (p) => {
        if (p.endsWith("Dockerfile")) return `ARG COFLAT_GIT_REF=${hex("a")}`;
        if (p.endsWith("compose.yaml")) {
          return [
            `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${hex("a")}}`,
            `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${hex("a")}}`,
          ].join("\n");
        }
        if (p.endsWith("ci.yml")) return `COFLAT_REF: ${hex("a")}`;
        return `git -C coflat checkout ${hex("a")}`;
      },
    });
    expect(drifted).toEqual([]);
  });

  it("flags a file when any repeated pin drifts", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["compose.yaml"],
      readFile: () => [
        `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${hex("a")}}`,
        `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${hex("b")}}`,
      ].join("\n"),
    });
    expect(drifted).toEqual([{ file: "compose.yaml", found: hex("b") }]);
  });

  it("flags Docker, Compose, and CI pins that drift", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["Dockerfile", "compose.yaml", ".github/workflows/ci.yml"],
      readFile: (p) => {
        if (p.endsWith("Dockerfile")) return `ARG COFLAT_GIT_REF=${hex("b")}`;
        if (p.endsWith("compose.yaml")) return `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${hex("c")}}`;
        return `COFLAT_REF: ${hex("d")}`;
      },
    });
    expect(drifted).toEqual([
      { file: "Dockerfile", found: hex("b") },
      { file: "compose.yaml", found: hex("c") },
      { file: ".github/workflows/ci.yml", found: hex("d") },
    ]);
  });

  it("flags config pins that are missing or floating refs", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["Dockerfile", "compose.yaml", ".github/workflows/ci.yml"],
      readFile: (p) => {
        if (p.endsWith("Dockerfile")) return "ARG COFLAT_GIT_REF=main";
        if (p.endsWith("compose.yaml")) return "COFLAT_GIT_REF: ${COFLAT_GIT_REF:-main}";
        return "COFLAT_REF: main";
      },
    });
    expect(drifted).toEqual([
      { file: "Dockerfile", found: "main" },
      { file: "compose.yaml", found: "main" },
      { file: ".github/workflows/ci.yml", found: "main" },
    ]);
  });

  it("flags docs that point at a floating Coflat ref", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["README.md", "AGENTS.md"],
      readFile: (p) => (p.endsWith("README.md") ? "git -C coflat checkout main" : `git -C coflat checkout ${hex("a")}`),
    });
    expect(drifted).toEqual([{ file: "README.md", found: "main" }]);
  });

  it("flags docs whose Coflat checkout pin is missing", () => {
    const drifted = checkDocPins({
      expectedRef: hex("a"),
      files: ["README.md", "AGENTS.md"],
      readFile: (p) => (p.endsWith("README.md") ? "no checkout here" : `git -C coflat checkout ${hex("a")}`),
    });
    expect(drifted).toEqual([{ file: "README.md", found: "<missing>" }]);
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

  it("keeps the live Coflat pins in sync with DEFAULT_COFLAT_REF", () => {
    // Regression guard for the real drift that shipped once: README pinned an
    // older SHA than the checker. This reads the actual docs, Docker/Compose,
    // and CI pin sites.
    expect(checkDocPins()).toEqual([]);
  });
});

describe("bumpCoflat", () => {
  it("rewrites the pin across the checker, docs, Docker, Compose, and CI", () => {
    const root = mkdtempSync(join(tmpdir(), "bump-coflat-"));
    const old = hex("a");
    const next = hex("c");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, ".gitea/workflows"), { recursive: true });
    writeFileSync(join(root, "scripts/check-coflat-ref.mjs"), `export const DEFAULT_COFLAT_REF = "${old}";\n`);
    writeFileSync(join(root, "README.md"), `prose\ngit -C coflat checkout ${old}\nmore\n`);
    writeFileSync(join(root, "AGENTS.md"), `git -C coflat checkout ${old}\n`);
    writeFileSync(join(root, "Dockerfile"), `ARG COFLAT_GIT_REF=${old}\n`);
    writeFileSync(join(root, "compose.yaml"), [
      `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${old}}`,
      `COFLAT_GIT_REF: $\{COFLAT_GIT_REF:-${old}}`,
      "",
    ].join("\n"));
    writeFileSync(join(root, ".github/workflows/ci.yml"), `COFLAT_REF: ${old}\n`);
    writeFileSync(join(root, ".gitea/workflows/ci.yml"), `COFLAT_REF: ${old}\n`);

    const updated = bumpCoflat({ sha: next, repoRoot: root });

    expect([...updated].sort()).toEqual([
      ".gitea/workflows/ci.yml",
      ".github/workflows/ci.yml",
      "AGENTS.md",
      "Dockerfile",
      "README.md",
      "compose.yaml",
      "scripts/check-coflat-ref.mjs",
    ]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`checkout ${next}`);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(`checkout ${next}`);
    expect(readFileSync(join(root, "scripts/check-coflat-ref.mjs"), "utf8")).toContain(`"${next}"`);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain(`=${next}`);
    const compose = readFileSync(join(root, "compose.yaml"), "utf8");
    expect(compose.match(new RegExp(next, "g"))).toHaveLength(2);
    expect(compose).not.toContain(old);
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toContain(`COFLAT_REF: ${next}`);
  });

  it("rejects a non-hex sha", () => {
    expect(() => bumpCoflat({ sha: "nope", repoRoot: "/tmp" })).toThrow(/40-hex/);
  });

  it("does not partially rewrite files when a later pin site is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "bump-coflat-"));
    const old = hex("a");
    const next = hex("c");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, "scripts/check-coflat-ref.mjs"), `export const DEFAULT_COFLAT_REF = "${old}";\n`);
    writeFileSync(join(root, "README.md"), `git -C coflat checkout ${old}\n`);
    writeFileSync(join(root, "AGENTS.md"), `git -C coflat checkout ${old}\n`);
    writeFileSync(join(root, "Dockerfile"), `ARG COFLAT_GIT_REF=${old}\n`);
    writeFileSync(join(root, "compose.yaml"), "COFLAT_GIT_REF: ${COFLAT_GIT_REF:-main}\n");
    writeFileSync(join(root, ".github/workflows/ci.yml"), `COFLAT_REF: ${old}\n`);

    expect(() => bumpCoflat({ sha: next, repoRoot: root })).toThrow(/compose\.yaml/);

    expect(readFileSync(join(root, "scripts/check-coflat-ref.mjs"), "utf8")).toContain(old);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(old);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(old);
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain(old);
    expect(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).toContain(old);
  });
});
