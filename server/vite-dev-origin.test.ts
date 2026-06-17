import { describe, expect, it } from "vitest";
import { viteDevOrigin } from "./vite-dev-origin.js";

describe("viteDevOrigin", () => {
  it("defaults to the standard Vite dev port", () => {
    expect(viteDevOrigin({})).toBe("http://localhost:5173");
  });

  it("uses COSHEAF_VITE_PORT when no explicit origin is set", () => {
    expect(viteDevOrigin({ COSHEAF_VITE_PORT: "5273" })).toBe("http://localhost:5273");
  });

  it("uses the web URL host when no explicit Vite origin is set", () => {
    expect(viteDevOrigin({
      COSHEAF_WEB_URL: "http://jupiter:3030",
      COSHEAF_VITE_PORT: "5273",
    })).toBe("http://jupiter:5273");
  });

  it("does not infer HTTPS Vite from an HTTPS web URL", () => {
    expect(viteDevOrigin({
      COSHEAF_WEB_URL: "https://cosheaf.lab",
      COSHEAF_VITE_PORT: "5273",
    })).toBe("http://localhost:5273");
  });

  it("lets COSHEAF_VITE_ORIGIN override the port-derived default", () => {
    expect(viteDevOrigin({
      COSHEAF_VITE_ORIGIN: "http://jupiter:6173",
      COSHEAF_VITE_PORT: "5273",
    })).toBe("http://jupiter:6173");
  });

  it("normalizes a trailing slash so generated asset URLs stay stable", () => {
    expect(viteDevOrigin({ COSHEAF_VITE_ORIGIN: "http://jupiter:6173/" }))
      .toBe("http://jupiter:6173");
  });

  it("normalizes explicit Vite origins to the URL origin", () => {
    expect(viteDevOrigin({ COSHEAF_VITE_ORIGIN: " http://jupiter:6173/some/path?x=1 " }))
      .toBe("http://jupiter:6173");
  });

  it("rejects malformed explicit Vite origins", () => {
    expect(() => viteDevOrigin({ COSHEAF_VITE_ORIGIN: "not a url" })).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => viteDevOrigin({ COSHEAF_VITE_ORIGIN: "ws://jupiter:6173" })).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => viteDevOrigin({ COSHEAF_VITE_ORIGIN: "file:///tmp/app.js" })).toThrow(/COSHEAF_VITE_ORIGIN/);
  });

  it("treats blank optional origin env values as unset", () => {
    expect(viteDevOrigin({
      COSHEAF_VITE_ORIGIN: "   ",
      COSHEAF_WEB_URL: " http://jupiter:3030 ",
      COSHEAF_VITE_PORT: "6173",
    })).toBe("http://jupiter:6173");
  });

  it("treats blank optional port env values as unset", () => {
    expect(viteDevOrigin({ COSHEAF_VITE_PORT: " " })).toBe("http://localhost:5173");
    expect(viteDevOrigin({ COSHEAF_WEB_URL: "http://jupiter:3030", COSHEAF_VITE_PORT: " " }))
      .toBe("http://jupiter:5173");
  });

  it("rejects malformed Vite port env values", () => {
    expect(() => viteDevOrigin({ COSHEAF_VITE_PORT: "abc" })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => viteDevOrigin({ COSHEAF_VITE_PORT: "65536" })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => viteDevOrigin({
      COSHEAF_WEB_URL: "http://jupiter:3030",
      COSHEAF_VITE_PORT: "abc",
    })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => viteDevOrigin({
      COSHEAF_WEB_URL: "http://jupiter:3030",
      COSHEAF_VITE_PORT: "65536",
    })).toThrow(/COSHEAF_VITE_PORT/);
  });
});
