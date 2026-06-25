import { describe, expect, it } from "vitest";
import { coflatEditorMode } from "./editor";

describe("coflatEditorMode", () => {
  it("uses Coflat rich-readonly mode for rich read-only mounts", () => {
    expect(coflatEditorMode("rich", true)).toBe("rich-readonly");
  });

  it("keeps editable and source modes unchanged", () => {
    expect(coflatEditorMode("rich", false)).toBe("rich");
    expect(coflatEditorMode("source", true)).toBe("source");
  });
});
