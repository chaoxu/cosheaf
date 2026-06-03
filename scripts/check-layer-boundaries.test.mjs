import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  collectModuleSpecifiers,
  findLayerBoundaryViolations,
  resolveRepoModulePath,
} from "./check-layer-boundaries.mjs";

function withRepo(fn) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "cosheaf-layer-boundary-"));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function write(repoRoot, rel, text = "export const value = 1;\n") {
  const filePath = path.join(repoRoot, rel);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
  return filePath;
}

describe("layer boundary checker", () => {
  it("collects import, export, and dynamic import specifiers", () => {
    expect(
      collectModuleSpecifiers(
        [
          'import { x } from "../shared/x";',
          'export { y } from "../shared/y";',
          'const z = import("../shared/z");',
        ].join("\n"),
        "/repo/server/example.ts",
      ),
    ).toEqual([
      { specifier: "../shared/x", line: 1 },
      { specifier: "../shared/y", line: 2 },
      { specifier: "../shared/z", line: 3 },
    ]);
  });

  it("resolves relative and repo-root module specifiers", () => withRepo((repoRoot) => {
    const serverFile = write(repoRoot, "server/routes/files.ts");
    const sharedFile = write(repoRoot, "shared/roles.ts");
    expect(resolveRepoModulePath("../../shared/roles.js", serverFile, repoRoot)).toBe(sharedFile);
    expect(resolveRepoModulePath("shared/roles.js", serverFile, repoRoot)).toBe(sharedFile);
  }));

  it("allows server and browser code to import shared modules", () => withRepo((repoRoot) => {
    const sharedFile = write(repoRoot, "shared/roles.ts");
    const serverFile = write(repoRoot, "server/routes/files.ts", 'import { role } from "../../shared/roles.js";\n');
    const browserFile = write(repoRoot, "src/cosheaf/api.ts", 'import { role } from "../../shared/roles.js";\n');
    expect(findLayerBoundaryViolations([
      { filePath: sharedFile },
      { filePath: serverFile },
      { filePath: browserFile },
    ], repoRoot)).toEqual([]);
  }));

  it("rejects shared imports from app layers", () => withRepo((repoRoot) => {
    const serverFile = write(repoRoot, "server/db.ts");
    const sharedFile = write(repoRoot, "shared/bad.ts", 'import { db } from "../server/db.js";\n');
    expect(findLayerBoundaryViolations([{ filePath: sharedFile }, { filePath: serverFile }], repoRoot)).toMatchObject([
      {
        filePath: sharedFile,
        line: 1,
        rule: "shared must not import app layers",
        specifier: "../server/db.js",
        targetPath: serverFile,
      },
    ]);
  }));

  it("rejects server/browser cross-imports", () => withRepo((repoRoot) => {
    write(repoRoot, "server/db.ts");
    const serverFile = write(repoRoot, "server/web.ts", 'import { api } from "../src/cosheaf/api.js";\n');
    const browserFile = write(repoRoot, "src/cosheaf/api.ts", 'import { config } from "../../server/db.js";\n');
    expect(findLayerBoundaryViolations([{ filePath: serverFile }, { filePath: browserFile }], repoRoot)).toMatchObject([
      { rule: "server must not import browser islands", specifier: "../src/cosheaf/api.js" },
      { rule: "browser islands must not import server code", specifier: "../../server/db.js" },
    ]);
  }));
});
