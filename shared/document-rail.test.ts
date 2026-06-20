import { describe, expect, it } from "vitest";
import { documentRailGroups, documentRailModel, documentRailOutline } from "./document-rail.js";

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

  it("builds the full rail model from one entrypoint", () => {
    expect(documentRailModel({
      mode: "edit",
      readHref: "/read",
      editHref: "/edit",
      editorMode: "rich",
      outline: [
        { key: "intro", level: 1, label: "Intro" },
        { key: "deep", level: 4, label: "Deep" },
      ],
    })).toEqual({
      groups: [
        {
          label: "Mode",
          controls: [
            { kind: "link", label: "Read", href: "/read", active: false, modeLink: true },
            { kind: "link", label: "Edit", href: "/edit", active: true, modeLink: true },
          ],
        },
        {
          label: "Editor",
          controls: [
            { kind: "button", label: "Rich", active: true },
            { kind: "button", label: "Source", active: false },
          ],
        },
      ],
      outline: [{ key: "intro", level: 1, label: "Intro", className: "doc-toc-link lvl-0" }],
    });
  });
});
