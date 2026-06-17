import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultApiUrl,
  defaultServerUrl,
  defaultViteUrl,
  defaultWebUrl,
  loadDotenvDev,
  serverPort,
  vitePort,
} from "./lib/env-dev.mjs";

const cleanup = [];

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

describe("devx env defaults", () => {
  it("derives the default web URL from COSHEAF_PORT", () => {
    expect(defaultWebUrl({ COSHEAF_PORT: "4040" })).toBe("http://localhost:4040");
  });

  it("lets COSHEAF_WEB_URL override the port-derived default", () => {
    expect(defaultWebUrl({ COSHEAF_WEB_URL: "http://cosheaf.lab", COSHEAF_PORT: "4040" }))
      .toBe("http://cosheaf.lab");
  });

  it("normalizes trailing slashes from COSHEAF_WEB_URL", () => {
    expect(defaultWebUrl({ COSHEAF_WEB_URL: "http://jupiter:4141///" })).toBe("http://jupiter:4141");
  });

  it("derives the default API URL from the default web URL", () => {
    expect(defaultApiUrl({ COSHEAF_WEB_URL: "http://jupiter:4141", COSHEAF_PORT: "3030" }))
      .toBe("http://jupiter:4141/api/v1");
  });

  it("derives the default API URL from COSHEAF_PORT when no web URL is set", () => {
    expect(defaultApiUrl({ COSHEAF_PORT: "4040" })).toBe("http://localhost:4040/api/v1");
  });

  it("lets COSHEAF_API_URL override the web-derived default", () => {
    expect(defaultApiUrl({ COSHEAF_API_URL: "http://api.lab/v1", COSHEAF_WEB_URL: "http://jupiter:4141" }))
      .toBe("http://api.lab/v1");
  });

  it("treats blank optional web/API URL env values as unset", () => {
    expect(defaultWebUrl({ COSHEAF_WEB_URL: "   ", COSHEAF_PORT: "4141" })).toBe("http://localhost:4141");
    expect(defaultWebUrl({ COSHEAF_PORT: " " })).toBe("http://localhost:3030");
    expect(defaultApiUrl({ COSHEAF_API_URL: " ", COSHEAF_WEB_URL: " http://jupiter:4141 " }))
      .toBe("http://jupiter:4141/api/v1");
  });

  it("normalizes server URL and port values for the dev proxy", () => {
    expect(defaultServerUrl({ COSHEAF_SERVER_URL: " http://jupiter:3030 ", COSHEAF_PORT: "4141" }))
      .toBe("http://jupiter:3030");
    expect(defaultServerUrl({ COSHEAF_SERVER_URL: " ", COSHEAF_PORT: "4141" })).toBe("http://localhost:4141");
    expect(defaultServerUrl({ COSHEAF_PORT: " " })).toBe("http://localhost:3030");
  });

  it("derives the default Vite URL from COSHEAF_VITE_PORT", () => {
    expect(defaultViteUrl({ COSHEAF_VITE_PORT: "6173" })).toBe("http://localhost:6173");
  });

  it("derives the default Vite URL from a remote web URL", () => {
    expect(defaultViteUrl({ COSHEAF_WEB_URL: "http://jupiter:3030", COSHEAF_VITE_PORT: "6173" }))
      .toBe("http://jupiter:6173");
  });

  it("does not infer HTTPS Vite from an HTTPS web URL", () => {
    expect(defaultViteUrl({ COSHEAF_WEB_URL: "https://cosheaf.lab", COSHEAF_VITE_PORT: "6173" }))
      .toBe("http://localhost:6173");
  });

  it("lets COSHEAF_VITE_ORIGIN override the port-derived default", () => {
    expect(defaultViteUrl({ COSHEAF_VITE_ORIGIN: "http://jupiter:6173///", COSHEAF_VITE_PORT: "5173" }))
      .toBe("http://jupiter:6173");
  });

  it("normalizes and validates explicit Vite origins", () => {
    expect(defaultViteUrl({ COSHEAF_VITE_ORIGIN: " http://jupiter:6173/path?x=1 " }))
      .toBe("http://jupiter:6173");
    expect(() => defaultViteUrl({ COSHEAF_VITE_ORIGIN: "not a url" })).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => defaultViteUrl({ COSHEAF_VITE_ORIGIN: "ws://jupiter:6173" })).toThrow(/COSHEAF_VITE_ORIGIN/);
    expect(() => defaultViteUrl({ COSHEAF_VITE_ORIGIN: "file:///tmp/app.js" })).toThrow(/COSHEAF_VITE_ORIGIN/);
  });

  it("treats blank optional Vite origin env values as unset", () => {
    expect(defaultViteUrl({
      COSHEAF_VITE_ORIGIN: " ",
      COSHEAF_WEB_URL: " http://jupiter:3030 ",
      COSHEAF_VITE_PORT: "6173",
    })).toBe("http://jupiter:6173");
  });

  it("treats blank optional Vite port env values as unset", () => {
    expect(defaultViteUrl({ COSHEAF_VITE_PORT: " " })).toBe("http://localhost:5173");
    expect(defaultViteUrl({ COSHEAF_WEB_URL: "http://jupiter:3030", COSHEAF_VITE_PORT: " " }))
      .toBe("http://jupiter:5173");
  });

  it("normalizes dev server ports for launcher arguments", () => {
    expect(serverPort({ COSHEAF_PORT: " 4141 " })).toBe("4141");
    expect(serverPort({ COSHEAF_PORT: " " })).toBe("3030");
    expect(vitePort({ COSHEAF_VITE_PORT: " 6173 " })).toBe("6173");
    expect(vitePort({ COSHEAF_VITE_PORT: " " })).toBe("5173");
  });

  it("rejects malformed dev server ports before launching", () => {
    expect(() => serverPort({ COSHEAF_PORT: "abc" })).toThrow(/COSHEAF_PORT/);
    expect(() => serverPort({ COSHEAF_PORT: "65536" })).toThrow(/COSHEAF_PORT/);
    expect(() => defaultWebUrl({ COSHEAF_PORT: "abc" })).toThrow(/COSHEAF_PORT/);
    expect(() => defaultServerUrl({ COSHEAF_SERVER_URL: " ", COSHEAF_PORT: "abc" })).toThrow(/COSHEAF_PORT/);
    expect(defaultServerUrl({ COSHEAF_SERVER_URL: "http://jupiter:3030", COSHEAF_PORT: "abc" }))
      .toBe("http://jupiter:3030");
    expect(() => vitePort({ COSHEAF_VITE_PORT: "abc" })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => vitePort({ COSHEAF_VITE_PORT: "65536" })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => defaultViteUrl({ COSHEAF_VITE_PORT: "abc" })).toThrow(/COSHEAF_VITE_PORT/);
    expect(() => defaultViteUrl({ COSHEAF_VITE_PORT: "65536" })).toThrow(/COSHEAF_VITE_PORT/);
  });

  it("loads .env.dev before the program builds default URLs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-devx-"));
    cleanup.push(cwd);
    const env = {};
    writeFileSync(join(cwd, ".env.dev"), "COSHEAF_PORT=4141\nCOSHEAF_WEB_URL=http://jupiter:4141\n");

    loadDotenvDev({ cwd, env });

    expect(defaultWebUrl(env)).toBe("http://jupiter:4141");
  });

  it("does not overwrite existing environment values", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-devx-"));
    cleanup.push(cwd);
    const env = { COSHEAF_PORT: "5151" };
    writeFileSync(join(cwd, ".env.dev"), "COSHEAF_PORT=4141\n");

    loadDotenvDev({ cwd, env });

    expect(env.COSHEAF_PORT).toBe("5151");
  });

  it("skips malformed empty keys", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-devx-"));
    cleanup.push(cwd);
    const env = {};
    writeFileSync(join(cwd, ".env.dev"), "=bad\nCOSHEAF_PORT=4141\n");

    loadDotenvDev({ cwd, env });

    expect(env).toEqual({ COSHEAF_PORT: "4141" });
  });

  it("unquotes only matched quotes around values", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-devx-"));
    cleanup.push(cwd);
    const env = {};
    writeFileSync(join(cwd, ".env.dev"), [
      'COSHEAF_WEB_URL="http://jupiter:4141/path with spaces"',
      "COSHEAF_API_URL='http://jupiter:4141/api/v1'",
      'COSHEAF_FORGEJO_URL="http://forgejo.test',
      "",
    ].join("\n"));

    loadDotenvDev({ cwd, env });

    expect(env).toMatchObject({
      COSHEAF_WEB_URL: "http://jupiter:4141/path with spaces",
      COSHEAF_API_URL: "http://jupiter:4141/api/v1",
      COSHEAF_FORGEJO_URL: '"http://forgejo.test',
    });
  });

  it("matches Node dotenv parsing for export prefixes and inline comments", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-devx-"));
    cleanup.push(cwd);
    const env = {};
    writeFileSync(join(cwd, ".env.dev"), [
      "export COSHEAF_PORT=4141",
      "COSHEAF_WEB_URL=http://jupiter:4141 # remote browser URL",
      "",
    ].join("\n"));

    loadDotenvDev({ cwd, env });

    expect(env).toMatchObject({
      COSHEAF_PORT: "4141",
      COSHEAF_WEB_URL: "http://jupiter:4141",
    });
  });
});
