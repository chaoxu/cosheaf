import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkEnvDev,
  checkForgejo,
  checkForgejoAdminToken,
  checkForgejoRuntimeToken,
} from "./doctor.mjs";

const env = {
  COSHEAF_FORGEJO_URL: "http://forgejo.test",
  COSHEAF_FORGEJO_TOKEN: "runtime-token",
  COSHEAF_FORGEJO_ADMIN_TOKEN: "admin-token",
};

const cleanup = [];

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

describe("preflight doctor Forgejo checks", () => {
  it("lets exported env override stale .env.dev values for runtime checks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-doctor-"));
    cleanup.push(cwd);
    const envPath = join(cwd, ".env.dev");
    writeFileSync(envPath, [
      "COSHEAF_FORGEJO_URL=http://stale.test",
      "COSHEAF_FORGEJO_TOKEN=stale-runtime",
      "COSHEAF_FORGEJO_ADMIN_TOKEN=stale-admin",
      "COSHEAF_WEBHOOK_SECRET=stale-secret",
      "",
    ].join("\n"));
    const result = checkEnvDev({
      path: envPath,
      runtimeEnv: {
        COSHEAF_FORGEJO_URL: "http://forgejo.test",
        COSHEAF_FORGEJO_TOKEN: "runtime-token",
        COSHEAF_FORGEJO_ADMIN_TOKEN: "admin-token",
        COSHEAF_WEBHOOK_SECRET: "secret",
      },
    });
    expect(result).toMatchObject({
      required: true,
      ok: true,
      label: ".env.dev required vars",
    });
    expect(result.env).toMatchObject({
      COSHEAF_FORGEJO_URL: "http://forgejo.test",
      COSHEAF_FORGEJO_TOKEN: "runtime-token",
      COSHEAF_FORGEJO_ADMIN_TOKEN: "admin-token",
      COSHEAF_WEBHOOK_SECRET: "secret",
    });
  });

  it("uses the shared .env.dev parser for malformed and quoted values", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-doctor-"));
    cleanup.push(cwd);
    const envPath = join(cwd, ".env.dev");
    writeFileSync(envPath, [
      "=bad",
      'COSHEAF_FORGEJO_URL="http://forgejo.test"',
      'COSHEAF_FORGEJO_TOKEN="runtime-token',
      "COSHEAF_FORGEJO_ADMIN_TOKEN='admin-token'",
      "COSHEAF_WEBHOOK_SECRET=secret",
      "",
    ].join("\n"));

    const result = checkEnvDev({ path: envPath, runtimeEnv: {} });

    expect(result).toMatchObject({
      ok: true,
      env: {
        COSHEAF_FORGEJO_URL: "http://forgejo.test",
        COSHEAF_FORGEJO_TOKEN: '"runtime-token',
        COSHEAF_FORGEJO_ADMIN_TOKEN: "admin-token",
        COSHEAF_WEBHOOK_SECRET: "secret",
      },
    });
    expect(Object.hasOwn(result.env, "")).toBe(false);
  });

  it("treats whitespace-only required env values as missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cosheaf-doctor-"));
    cleanup.push(cwd);
    const envPath = join(cwd, ".env.dev");
    writeFileSync(envPath, [
      "COSHEAF_FORGEJO_URL=http://forgejo.test",
      "COSHEAF_FORGEJO_TOKEN='   '",
      "COSHEAF_FORGEJO_ADMIN_TOKEN='   '",
      "COSHEAF_WEBHOOK_SECRET=secret",
      "",
    ].join("\n"));

    const result = checkEnvDev({ path: envPath, runtimeEnv: {} });

    expect(result).toMatchObject({
      required: true,
      ok: false,
      label: ".env.dev required vars",
      detail: "empty: COSHEAF_FORGEJO_TOKEN, COSHEAF_FORGEJO_ADMIN_TOKEN",
    });
  });

  it("treats Forgejo reachability as advisory", async () => {
    await expect(checkForgejo(env, { tcpOpenFn: async () => false })).resolves.toMatchObject({
      required: false,
      ok: false,
      label: "Forgejo reachable",
    });
  });

  it("accepts a non-admin runtime token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ login: "cosheaf", is_admin: false }));

    await expect(checkForgejoRuntimeToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: true,
      label: "Forgejo runtime token",
      detail: "cosheaf",
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/api/v1/user", env.COSHEAF_FORGEJO_URL), {
      headers: { authorization: "token runtime-token" },
    });
  });

  it("rejects a site-admin runtime token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ login: "root", is_admin: true }));

    await expect(checkForgejoRuntimeToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: false,
      label: "Forgejo runtime token",
      detail: expect.stringContaining("site-admin"),
    });
  });

  it("rejects invalid runtime and admin tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));

    await expect(checkForgejoRuntimeToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: false,
      detail: "token rejected",
    });
    await expect(checkForgejoAdminToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: false,
      detail: "token rejected (not admin?)",
    });
  });

  it("accepts an admin token with admin API access", async () => {
    const fetchImpl = vi.fn(async () => Response.json([]));

    await expect(checkForgejoAdminToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: true,
      label: "Forgejo admin token",
      detail: "ok",
    });
    expect(fetchImpl).toHaveBeenCalledWith(new URL("/api/v1/admin/users?limit=1", env.COSHEAF_FORGEJO_URL), {
      headers: { authorization: "token admin-token" },
    });
  });

  it("reports token probe errors instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(checkForgejoRuntimeToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: false,
      detail: "connection reset",
    });
    await expect(checkForgejoAdminToken(env, { fetchImpl })).resolves.toMatchObject({
      required: true,
      ok: false,
      detail: "connection reset",
    });
  });
});
