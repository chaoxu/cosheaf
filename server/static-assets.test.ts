import path from "node:path";
import { describe, expect, it } from "vitest";
import { listPublicAssetPaths } from "./static-assets.js";

const publicDir = path.join(__dirname, "..", "public");

describe("listPublicAssetPaths", () => {
  it("serves the css, the favicon, and every cosheaf-*.js island helper", () => {
    const paths = listPublicAssetPaths(publicDir);
    expect(paths).toContain("/cosheaf-web.css");
    expect(paths).toContain("/favicon.svg");
    expect(paths).toContain("/cosheaf-notifications.js");
    // Every served .js is a cosheaf-* island helper (the scan never widens
    // beyond the helper prefix).
    const served = paths.filter((p) => p.endsWith(".js"));
    expect(served.length).toBeGreaterThan(0);
    expect(served.every((p) => p.startsWith("/cosheaf-"))).toBe(true);
  });

  it("skips the fonts/ subdirectory (served by /fonts/*) and any non-asset files", () => {
    const paths = listPublicAssetPaths(publicDir);
    expect(paths.some((p) => p === "/fonts" || p.startsWith("/fonts/"))).toBe(false);
  });

  it("returns [] for a missing directory", () => {
    expect(listPublicAssetPaths(path.join(__dirname, "..", "does-not-exist"))).toEqual([]);
  });
});
