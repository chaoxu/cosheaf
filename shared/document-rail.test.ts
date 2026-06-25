import { describe, expect, it } from "vitest";
import { documentRailGroups, documentRailModel, documentRailOutline } from "./document-rail.js";

describe("document rail model", () => {
  it("uses one group model for read and edit rails", () => {
    expect(documentRailGroups({
      mode: "read",
      readHref: "/read",
      editHref: "/edit",
    })).toMatchObject([
      { label: "View", controls: [{ label: "Read", active: true }, { label: "Edit", active: false }] },
    ]);
    expect(documentRailGroups({
      mode: "edit",
      readHref: "/read",
      editHref: "/edit",
    })).toMatchObject([
      { label: "View", controls: [{ label: "Read", active: false }, { label: "Edit", active: true }] },
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
      outline: [
        { key: "intro", level: 1, label: "Intro" },
        { key: "deep", level: 4, label: "Deep" },
      ],
    })).toEqual({
      groups: [
        {
          label: "View",
          controls: [
            { kind: "link", label: "Read", href: "/read", active: false, modeLink: true },
            { kind: "link", label: "Edit", href: "/edit", active: true, modeLink: true },
          ],
        },
      ],
      outline: [{ key: "intro", level: 1, label: "Intro", className: "doc-toc-link lvl-0" }],
    });
  });
});
