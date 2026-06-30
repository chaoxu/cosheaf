// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { frontmatterField } from "@chaoxu/coflat";
import { describe, expect, it } from "vitest";
import {
  coflatEditorMode,
  frontmatterYamlDiagnostics,
  sourceModeTab,
} from "./editor";

describe("coflatEditorMode", () => {
  it("uses Coflat rich-readonly mode for rich read-only mounts", () => {
    expect(coflatEditorMode("rich", true)).toBe("rich-readonly");
  });

  it("keeps editable and source modes unchanged", () => {
    expect(coflatEditorMode("rich", false)).toBe("rich");
    expect(coflatEditorMode("source", true)).toBe("source");
  });
});

describe("sourceModeTab", () => {
  it("inserts spaces instead of a literal tab inside YAML frontmatter", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "---\ntitle: Hello\n---\nBody",
        selection: { anchor: "---\ntitle".length },
        extensions: [frontmatterField],
      }),
      parent: document.body,
    });

    sourceModeTab(view);

    expect(view.state.doc.toString()).toBe("---\ntitle  : Hello\n---\nBody");
    view.destroy();
  });

  it("keeps normal literal-tab behavior outside frontmatter", () => {
    const doc = "---\ntitle: Hello\n---\nBody";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [frontmatterField],
      }),
      parent: document.body,
    });

    sourceModeTab(view);

    expect(view.state.doc.toString()).toBe("---\ntitle: Hello\n---\nBody\t");
    view.destroy();
  });
});

describe("frontmatterYamlDiagnostics", () => {
  it("reports malformed tab-indented YAML frontmatter", () => {
    const state = EditorState.create({
      doc: "---\nmath:\n\t\\\\R: \\\\mathbb{R}\n---\nBody",
      extensions: [frontmatterField],
    });

    expect(frontmatterYamlDiagnostics(state)).toEqual([
      expect.objectContaining({
        from: 0,
        severity: "error",
        source: "YAML frontmatter",
        message: expect.stringContaining("Tabs"),
      }),
    ]);
  });

  it("does not report diagnostics for valid YAML frontmatter", () => {
    const state = EditorState.create({
      doc: "---\nmath:\n  \\\\R: \\\\mathbb{R}\n---\nBody",
      extensions: [frontmatterField],
    });

    expect(frontmatterYamlDiagnostics(state)).toEqual([]);
  });
});
