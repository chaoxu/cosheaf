import { describe, expect, it } from "vitest";
import { WorkspaceBackendError, type WorkspaceBackend } from "./workspace-backend.js";
import { bustRepoConfig, loadRepoConfig, parseRepoConfig } from "./repo-config.js";
import { freshTestDb } from "./routes/test-fixtures.js";

// cosheaf.yaml uses single-quoted YAML so the backslashes in macros stay literal.
const YAML_R = "math:\n  '\\R': '\\mathbb{R}'\n";

function fakeBackend(getRawFile: () => Promise<string>): WorkspaceBackend {
  return { getRawFile } as unknown as WorkspaceBackend;
}

describe("parseRepoConfig", () => {
  it("extracts string math macros from the math: map", () => {
    expect(parseRepoConfig(YAML_R).mathMacros).toEqual({ "\\R": "\\mathbb{R}" });
  });

  it("extracts paper defaults and configured asset folder", () => {
    expect(parseRepoConfig([
      "assets:",
      "  folder: figures",
      "bibliography: refs/main.bib",
      "csl: styles/journal.csl",
      "template: templates/article.tex",
      "blocks:",
      "  claim:",
      "    title: Claim",
      "",
    ].join("\n"))).toMatchObject({
      assetFolder: "figures",
      bibliography: "refs/main.bib",
      csl: "styles/journal.csl",
      pdfBibliography: "refs/main.bib",
      pdfCsl: "styles/journal.csl",
      pdfTemplate: "templates/article.tex",
      blockDefinitions: { claim: { title: "Claim" } },
    });
  });

  it("supports latex/pdf nested paper defaults and rejects unsafe asset folders", () => {
    expect(parseRepoConfig("assets: ../escape\nlatex:\n  bibliography: refs/main.bib\npdf:\n  template: lipics\n")).toMatchObject({
      assetFolder: "assets",
      pdfBibliography: "refs/main.bib",
      pdfTemplate: "lipics",
    });
  });

  it("keeps reader defaults separate from PDF-specific defaults", () => {
    expect(parseRepoConfig([
      "bibliography: refs/reader.bib",
      "csl: styles/reader.csl",
      "latex:",
      "  bibliography: refs/export.bib",
      "  csl: ieee",
      "pdf:",
      "  template: lipics",
      "",
    ].join("\n"))).toMatchObject({
      bibliography: "refs/reader.bib",
      csl: "styles/reader.csl",
      pdfBibliography: "refs/export.bib",
      pdfCsl: "ieee",
      pdfTemplate: "lipics",
    });
  });

  it("ignores non-string values, missing math, and empty input", () => {
    expect(parseRepoConfig("math:\n  R: 5\n").mathMacros).toEqual({});
    expect(parseRepoConfig("other: 1\n").mathMacros).toEqual({});
    expect(parseRepoConfig("").mathMacros).toEqual({});
  });

  it("returns empty config on invalid YAML or a non-object root", () => {
    expect(parseRepoConfig(": : :").mathMacros).toEqual({});
    expect(parseRepoConfig("- a\n- b\n").mathMacros).toEqual({});
  });

  it("parses named export profiles and honors a valid defaultProfile (#389)", () => {
    const cfg = parseRepoConfig([
      "export:",
      "  defaultProfile: journal",
      "  profiles:",
      "    journal:",
      "      bibliography: refs/main.bib",
      "      csl: ieee",
      "      template: lipics",
      "      cslLocale: en-US",
      "      defaults: .cosheaf/export/journal.yaml",
      "    plain: {}",
      "",
    ].join("\n"));
    expect(cfg.exportProfiles.journal).toEqual({
      bibliography: "refs/main.bib",
      csl: "ieee",
      template: "lipics",
      cslLocale: "en-US",
      defaults: ".cosheaf/export/journal.yaml",
    });
    expect(cfg.exportProfiles.plain).toEqual({});
    expect(cfg.defaultProfile).toBe("journal");
  });

  it("drops a defaultProfile that names no existing profile, and empty export block", () => {
    expect(parseRepoConfig("export:\n  defaultProfile: ghost\n  profiles:\n    real: {}\n").defaultProfile).toBeUndefined();
    expect(parseRepoConfig("other: 1\n").exportProfiles).toEqual({});
  });
});

describe("loadRepoConfig", () => {
  it("fetches+parses+caches on a miss, then serves the cache without refetching", async () => {
    const db = freshTestDb("cosheaf-repocfg-");
    let fetches = 0;
    const fj = fakeBackend(async () => {
      fetches++;
      return YAML_R;
    });
    expect((await loadRepoConfig(db, fj, "o", "w", "main")).mathMacros).toEqual({ "\\R": "\\mathbb{R}" });
    expect((await loadRepoConfig(db, fj, "o", "w", "main")).mathMacros).toEqual({ "\\R": "\\mathbb{R}" });
    expect(fetches).toBe(1);
  });

  it("caches the empty config when cosheaf.yaml is missing (404), not refetched", async () => {
    const db = freshTestDb("cosheaf-repocfg-");
    let fetches = 0;
    const fj = fakeBackend(async () => {
      fetches++;
      throw new WorkspaceBackendError(404, "not_found", "not found");
    });
    expect((await loadRepoConfig(db, fj, "o", "w", "main")).mathMacros).toEqual({});
    await loadRepoConfig(db, fj, "o", "w", "main");
    expect(fetches).toBe(1);
  });

  it("does not cache a transient (non-404) fetch failure", async () => {
    const db = freshTestDb("cosheaf-repocfg-");
    let fetches = 0;
    const fj = fakeBackend(async () => {
      fetches++;
      throw new WorkspaceBackendError(502, "error", "upstream");
    });
    await loadRepoConfig(db, fj, "o", "w", "main");
    await loadRepoConfig(db, fj, "o", "w", "main");
    expect(fetches).toBe(2); // retried — not cached
  });

  it("coalesces concurrent cold-cache loads into a single fetch (no herd)", async () => {
    const db = freshTestDb("cosheaf-repocfg-");
    let fetches = 0;
    const fj = fakeBackend(async () => {
      fetches++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return YAML_R;
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => loadRepoConfig(db, fj, "o", "w", "main")));
    expect(fetches).toBe(1);
    for (const r of results) expect(r.mathMacros).toEqual({ "\\R": "\\mathbb{R}" });
  });

  it("bustRepoConfig forces a reload (edit-then-reconcile)", async () => {
    const db = freshTestDb("cosheaf-repocfg-");
    let body = YAML_R;
    let fetches = 0;
    const fj = fakeBackend(async () => {
      fetches++;
      return body;
    });
    await loadRepoConfig(db, fj, "o", "w", "main");
    body = "math:\n  '\\R': '\\mathbb{Q}'\n";
    bustRepoConfig(db, "o/w", "main");
    expect((await loadRepoConfig(db, fj, "o", "w", "main")).mathMacros).toEqual({ "\\R": "\\mathbb{Q}" });
    expect(fetches).toBe(2);
  });
});
