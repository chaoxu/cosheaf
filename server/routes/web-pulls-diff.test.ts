import { describe, expect, it } from "vitest";
import { parseDiffMode, parseDiffShape } from "./web-pulls-diff.js";

describe("parseDiffMode", () => {
  it("defaults to rich when rich is available and no mode is given", () => {
    expect(parseDiffMode(undefined, true)).toBe("rich");
  });

  it("honors an explicit source choice", () => {
    expect(parseDiffMode("source", true)).toBe("source");
    expect(parseDiffMode("rich", true)).toBe("rich");
  });

  it("coerces to source for passthrough (richOk=false), ignoring the requested mode", () => {
    // The server is the source of truth: a stale ?mode=rich or saved preference
    // must not reach the (nonexistent) rich surface on a passthrough workspace.
    expect(parseDiffMode(undefined, false)).toBe("source");
    expect(parseDiffMode("rich", false)).toBe("source");
    expect(parseDiffMode("source", false)).toBe("source");
  });

  it("treats an unknown mode as the rich default when rich is available", () => {
    expect(parseDiffMode("nonsense", true)).toBe("rich");
  });
});

describe("parseDiffShape", () => {
  it("defaults to after for an unset or unknown shape", () => {
    expect(parseDiffShape(undefined, "source")).toBe("after");
    expect(parseDiffShape("nonsense", "source")).toBe("after");
  });

  it("passes through valid shapes in source mode", () => {
    expect(parseDiffShape("unified", "source")).toBe("unified");
    expect(parseDiffShape("split", "source")).toBe("split");
    expect(parseDiffShape("after", "source")).toBe("after");
  });

  it("disables the unified shape under rich mode (coerces to after)", () => {
    expect(parseDiffShape("unified", "rich")).toBe("after");
  });

  it("keeps split/after under rich mode", () => {
    expect(parseDiffShape("split", "rich")).toBe("split");
    expect(parseDiffShape("after", "rich")).toBe("after");
  });
});
