import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("serves from dist/ when public/ is absent (the production image layout)", () => {
    // Regression: the image ships only dist/ (Vite copies public/ → dist/), so a
    // public-only scan 404'd every asset in prod. The dist root must be scanned.
    const root = mkdtempSync(path.join(tmpdir(), "cosheaf-assets-"));
    const distDir = path.join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    for (const name of ["cosheaf-web.css", "cosheaf-notifications.js", "favicon.svg"]) {
      writeFileSync(path.join(distDir, name), "");
    }
    const missingPublic = path.join(root, "public");
    expect(listPublicAssetPaths(missingPublic, distDir)).toEqual([
      "/cosheaf-notifications.js",
      "/cosheaf-web.css",
      "/favicon.svg",
    ]);
  });

  it("unions the roots and de-duplicates assets present in both", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cosheaf-assets-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(a, "cosheaf-web.css"), "");
    writeFileSync(path.join(b, "cosheaf-web.css"), ""); // same name in both roots
    writeFileSync(path.join(b, "cosheaf-extra.js"), "");
    expect(listPublicAssetPaths(a, b)).toEqual(["/cosheaf-extra.js", "/cosheaf-web.css"]);
  });
});
