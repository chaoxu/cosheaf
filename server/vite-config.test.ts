import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { viteApiProxyTarget, viteFsAllow, viteHostForOrigin, viteOrigin, viteOriginFromWebUrl } from "../vite.config.js";

describe("vite dev server remote origin helpers", () => {
  it("binds externally for non-local Vite origins", () => {
    expect(viteHostForOrigin("http://jupiter:5173")).toBe("0.0.0.0");
  });

  it("keeps local Vite origins on Vite's default bind host", () => {
    expect(viteHostForOrigin("http://localhost:5173")).toBeUndefined();
    expect(viteHostForOrigin("http://127.0.0.1:5173")).toBeUndefined();
    expect(viteHostForOrigin("http://[::1]:5173")).toBeUndefined();
  });

  it("ignores malformed origins", () => {
    expect(viteHostForOrigin("not a url")).toBeUndefined();
  });

  it("derives an http Vite origin from an http web URL", () => {
    expect(viteOriginFromWebUrl("http://jupiter:3030", "6173")).toBe("http://jupiter:6173/");
  });

  it("trims and ignores blank web URL env values", () => {
    expect(viteOriginFromWebUrl(" http://jupiter:3030 ", "6173")).toBe("http://jupiter:6173/");
    expect(viteOriginFromWebUrl("   ", "6173")).toBeUndefined();
  });

  it("defaults a blank Vite port while deriving from the web URL", () => {
    expect(viteOriginFromWebUrl("http://jupiter:3030", " ")).toBe("http://jupiter:5173/");
  });

  it("rejects malformed Vite ports while deriving from the web URL", () => {
    expect(() => viteOriginFromWebUrl("http://jupiter:3030", "abc")).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => viteOriginFromWebUrl("http://jupiter:3030", "65536")).toThrow(/COSHEAF_VITE_PORT/);
  });

  it("does not derive a fake HTTPS Vite origin", () => {
    expect(viteOriginFromWebUrl("https://cosheaf.lab", "6173")).toBeUndefined();
  });

  it("normalizes and validates explicit Vite origins", () => {
    expect(viteOrigin(" http://jupiter:6173/path?x=1 ")).toBe("http://jupiter:6173");
    expect(viteOrigin(" ")).toBeUndefined();
    expect(() => viteOrigin("not a url")).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => viteOrigin("ws://jupiter:6173")).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => viteOrigin("file:///tmp/app.js")).toThrow(/COSHEAF_VITE_ORIGIN/);
  });

  it("uses an explicit API proxy target when set", () => {
    expect(viteApiProxyTarget("http://jupiter:3030", "4141")).toBe("http://jupiter:3030");
  });

  it("trims and ignores blank API proxy target inputs", () => {
    expect(viteApiProxyTarget(" http://jupiter:3030 ", "4141")).toBe("http://jupiter:3030");
    expect(viteApiProxyTarget(" ", "4141")).toBe("http://localhost:4141");
    expect(viteApiProxyTarget(undefined, " ")).toBe("http://localhost:3030");
  });

  it("rejects malformed API proxy fallback ports", () => {
    expect(viteApiProxyTarget("http://jupiter:3030", "abc")).toBe("http://jupiter:3030");
    expect(() => viteApiProxyTarget(" ", "abc")).toThrow(/COSHEAF_PORT/);
    expect(() => viteApiProxyTarget(" ", "65536")).toThrow(/COSHEAF_PORT/);
  });

  it("allows the repo root for Vite file-system asset URLs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cosheaf-vite-root-"));
    try {
      expect(viteFsAllow(root)).toEqual([root]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a symlinked node_modules target for Vite file-system asset URLs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cosheaf-vite-root-"));
    const shared = mkdtempSync(path.join(tmpdir(), "cosheaf-vite-shared-"));
    try {
      mkdirSync(path.join(shared, "node_modules"));
      symlinkSync(path.join(shared, "node_modules"), path.join(root, "node_modules"));

      expect(viteFsAllow(root)).toEqual([root, realpathSync(path.join(shared, "node_modules"))]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });
});
