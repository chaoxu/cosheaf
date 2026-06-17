import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, normalizeOptionalOrigin, parsePort, parseTrustedProxyHops, validateTrustedProxyOrigin } from "./db.js";

const ENV_KEYS = [
  "COSHEAF_DATA_DIR",
  "COSHEAF_PORT",
  "COSHEAF_FORGEJO_URL",
  "COSHEAF_FORGEJO_TOKEN",
  "COSHEAF_FORGEJO_ADMIN_TOKEN",
  "COSHEAF_WEBHOOK_SECRET",
  "COSHEAF_WEBHOOK_URL",
  "COSHEAF_PUBLIC_ORIGIN",
  "COSHEAF_REGISTRATION_MODE",
  "COSHEAF_TRUSTED_PROXY_HOPS",
  "COSHEAF_COVERIFY_CMD",
  "COSHEAF_COVERIFY_API_URL",
  "COSHEAF_COVERIFY_BOT_TOKEN",
  "COSHEAF_COVERIFY_BOT_LOGIN",
] as const;

let cleanupDir: string | null = null;
const originalEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  originalEnv.clear();
  if (cleanupDir) {
    rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = null;
  }
});

function setTestEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

describe("normalizeOptionalOrigin", () => {
  it("treats missing and blank values as unset", () => {
    expect(normalizeOptionalOrigin(undefined)).toBeNull();
    expect(normalizeOptionalOrigin("   ")).toBeNull();
  });

  it("normalizes absolute URLs to their origin", () => {
    expect(normalizeOptionalOrigin("https://cosheaf.lab/path?q=1")).toBe("https://cosheaf.lab");
    expect(normalizeOptionalOrigin("http://localhost:3030/")).toBe("http://localhost:3030");
  });

  it("rejects non-absolute values", () => {
    expect(() => normalizeOptionalOrigin("cosheaf.lab")).toThrow();
  });

  it("rejects non-http origins", () => {
    expect(() => normalizeOptionalOrigin("file:///tmp/cosheaf")).toThrow();
    expect(() => normalizeOptionalOrigin("mailto:ops@example.com")).toThrow();
  });
});

describe("parseTrustedProxyHops", () => {
  it("defaults missing and blank values to zero", () => {
    expect(parseTrustedProxyHops(undefined)).toBe(0);
    expect(parseTrustedProxyHops("  ")).toBe(0);
  });

  it("accepts non-negative integers", () => {
    expect(parseTrustedProxyHops("0")).toBe(0);
    expect(parseTrustedProxyHops("2")).toBe(2);
  });

  it("rejects negative, fractional, and partially parsed values", () => {
    expect(() => parseTrustedProxyHops("-1")).toThrow();
    expect(() => parseTrustedProxyHops("1.5")).toThrow();
    expect(() => parseTrustedProxyHops("1junk")).toThrow();
    expect(() => parseTrustedProxyHops("abc")).toThrow();
  });
});

describe("parsePort", () => {
  it("defaults missing and blank values to the supplied fallback", () => {
    expect(parsePort(undefined, 3030)).toBe(3030);
    expect(parsePort("  ", 3030)).toBe(3030);
  });

  it("accepts integer ports in the TCP range without partial parsing", () => {
    expect(parsePort("0", 3030)).toBe(0);
    expect(parsePort(" 4040 ", 3030)).toBe(4040);
    expect(parsePort("65535", 3030)).toBe(65535);
  });

  it("rejects invalid port values", () => {
    expect(() => parsePort("-1", 3030)).toThrow();
    expect(() => parsePort("1.5", 3030)).toThrow();
    expect(() => parsePort("3030junk", 3030)).toThrow();
    expect(() => parsePort("65536", 3030)).toThrow();
    expect(() => parsePort("abc", 3030)).toThrow();
  });
});

describe("loadConfig", () => {
  it("treats blank defaulted env vars as unset", () => {
    cleanupDir = mkdtempSync(path.join(tmpdir(), "cosheaf-config-"));
    setTestEnv({
      COSHEAF_DATA_DIR: cleanupDir,
      COSHEAF_PORT: " ",
      COSHEAF_FORGEJO_URL: " ",
      COSHEAF_FORGEJO_TOKEN: "runtime-token",
      COSHEAF_FORGEJO_ADMIN_TOKEN: "admin-token",
      COSHEAF_WEBHOOK_SECRET: "secret",
      COSHEAF_WEBHOOK_URL: " ",
      COSHEAF_COVERIFY_CMD: " ",
      COSHEAF_COVERIFY_API_URL: " ",
      COSHEAF_COVERIFY_BOT_TOKEN: " ",
      COSHEAF_COVERIFY_BOT_LOGIN: " ",
    });

    const config = loadConfig();

    expect(config.port).toBe(3030);
    expect(config.forgejoUrl).toBe("http://127.0.0.1:3002");
    expect(config.webhookUrl).toBe("http://127.0.0.1:3030/api/v1/webhooks/forgejo");
    expect(config.coverifyCmd).toBe("coverify");
    expect(config.coverifyApiUrl).toBe("http://127.0.0.1:3030/api/v1");
    expect(config.coverifyBotToken).toBe("");
    expect(config.coverifyBotLogin).toBe("coverify");
  });
});

describe("validateTrustedProxyOrigin", () => {
  it("requires a public origin when forwarded headers are trusted", () => {
    expect(() => validateTrustedProxyOrigin(null, 1)).toThrow(/COSHEAF_PUBLIC_ORIGIN/);
    expect(() => validateTrustedProxyOrigin("https://cosheaf.lab", 1)).not.toThrow();
    expect(() => validateTrustedProxyOrigin(null, 0)).not.toThrow();
  });
});
