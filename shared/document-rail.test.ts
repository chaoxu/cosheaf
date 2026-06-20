import { describe, expect, it } from "vitest";
import { documentRailGroups, documentRailOutline } from "./document-rail.js";

describe("document rail model", () => {
  it("uses one group model for read and edit rails", () => {
    expect(documentRailGroups({
      mode: "read",
      readHref: "/read",
      editHref: "/edit",
      fileControls: [{ kind: "link", label: "Raw", href: "/raw" }],
    })).toMatchObject([
      { label: "Mode", controls: [{ label: "Read", active: true }, { label: "Edit", active: false }] },
      { label: "File", controls: [{ label: "Raw", href: "/raw" }] },
    ]);
    expect(documentRailGroups({
      mode: "edit",
      readHref: "/read",
      editHref: "/edit",
      editorMode: "source",
    })).toMatchObject([
      { label: "Mode", controls: [{ label: "Read", active: false }, { label: "Edit", active: true }] },
      { label: "Editor", controls: [{ label: "Rich", active: false }, { label: "Source", active: true }] },
    ]);
  });

  it("normalizes reader and editor outlines with the same depth and classes", () => {
    expect(documentRailOutline([
      { key: "a", level: 2, label: "A" },
      { key: "b", level: 3, label: "B" },
      { key: "c", level: 4, label: "C" },
    ])).toEqual([
      { key: "a", level: 2, label: "A", className: "doc-toc-link lvl-0" },
      { key: "b", level: 3, label: "B", className: "doc-toc-link lvl-1" },
    ]);
  });
});
