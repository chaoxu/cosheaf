import { describe, expect, it } from "vitest";
import { browserAppUrl, browserWebUrl, serverRenderedOrigin } from "./browser-utils.mjs";

describe("browser smoke URL helpers", () => {
  it("defaults browser smoke entrypoint from the normalized web URL", () => {
    expect(browserAppUrl({ COSHEAF_PORT: "4141" })).toBe("http://localhost:4141/");
    expect(browserAppUrl({ COSHEAF_WEB_URL: " http://jupiter:4141 " })).toBe("http://jupiter:4141/");
  });

  it("lets URL override the default browser smoke entrypoint", () => {
    expect(browserAppUrl({ URL: " http://localhost:6173/workspace " })).toBe("http://localhost:6173/workspace");
  });

  it("lets URL override COSHEAF_WEB_URL for server-rendered browser flows", () => {
    expect(browserWebUrl({
      URL: " http://jupiter:8080/workspace ",
      COSHEAF_WEB_URL: "http://localhost:3030",
    })).toBe("http://jupiter:8080/workspace");
  });

  it("derives the server-rendered origin from a local Vite URL", () => {
    expect(serverRenderedOrigin("http://localhost:6173/", {
      COSHEAF_VITE_PORT: "6173",
      COSHEAF_PORT: "4141",
    })).toBe("http://localhost:4141/");
  });

  it("derives the server-rendered origin from a local IPv6 Vite URL", () => {
    expect(serverRenderedOrigin("http://[::1]:6173/", {
      COSHEAF_VITE_PORT: "6173",
      COSHEAF_PORT: "4141",
    })).toBe("http://[::1]:4141/");
  });

  it("does not rewrite remote or non-Vite URLs", () => {
    expect(serverRenderedOrigin("http://jupiter:6173/", {
      COSHEAF_VITE_PORT: "6173",
      COSHEAF_PORT: "4141",
    })).toBe("http://jupiter:6173/");
    expect(serverRenderedOrigin("http://localhost:4141/", {
      COSHEAF_VITE_PORT: "6173",
      COSHEAF_PORT: "4141",
    })).toBe("http://localhost:4141/");
  });

  it("treats blank smoke URL values as unset", () => {
    expect(browserWebUrl({
      URL: " ",
      COSHEAF_WEB_URL: " ",
      COSHEAF_PORT: "4141",
    })).toBe("http://localhost:4141/");
  });

  it("rejects malformed port values before smoke scripts launch", () => {
    expect(() => browserWebUrl({ COSHEAF_PORT: "abc" })).toThrow(/COSHEAF_PORT/);
    expect(() => serverRenderedOrigin("http://localhost:6173/", {
      COSHEAF_VITE_PORT: "abc",
      COSHEAF_PORT: "4141",
    })).toThrow(/COSHEAF_VITE_PORT/);
  });
});
