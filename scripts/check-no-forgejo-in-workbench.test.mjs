import path from "node:path";
import { describe, expect, it } from "vitest";

import { findForgeReferences } from "./check-no-forgejo-in-workbench.mjs";

const FILE = path.join(process.cwd(), "server", "local", "example.ts");

describe("no-forge workbench gate", () => {
  it("flags a forge import in workbench code", () => {
    expect(
      findForgeReferences(FILE, 'import { Forgejo } from "../forgejo.js";\nconst x = 1;\n'),
    ).toEqual([{ filePath: FILE, line: 1, text: "Forgejo" }]);
  });

  it("flags fjUser and forgejoToken references", () => {
    const out = findForgeReferences(FILE, "const a = c.get('fjUser');\nconst b = forgejoToken;\n");
    expect(out.map((v) => v.line)).toEqual([1, 2]);
  });

  it("allows forge-free workbench code", () => {
    expect(
      findForgeReferences(FILE, "import { WorkspaceBackend } from '../workspace-backend.js';\nconst forge = null;\n"),
    ).toEqual([]);
  });
});
