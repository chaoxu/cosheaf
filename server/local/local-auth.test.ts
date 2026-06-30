import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig, isLoopbackHost, refuseRemoteWithoutToken } from "../db.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
  originId: "local-test-origin",
};

const TOKEN = "s3cret-workbench-token";

// Build a fresh single-workspace local app. Created per test (the test db is
// closed on teardown, so an app must not outlive its `it`).
function localApp(accessToken: string | null): Hono<AppEnv> {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-auth-"));
  writeFileSync(join(dir, "hello.md"), "# Hello\n");
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0, accessToken });
  const db = freshTestDb("cosheaf-local-auth-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  return createApp({ config, db, workspaceBackend: backend, localWorkspace: IDENTITY });
}

describe("local Workbench access gate", () => {
  describe("no token configured (default loopback no-auth)", () => {
    it("serves the API without credentials", async () => {
      const app = localApp(null);
      expect((await app.request("/api/v1/repos/me/notes/tree?branch=main")).status).toBe(200);
    });

    it("serves web pages without credentials", async () => {
      const app = localApp(null);
      expect((await app.request("/me/notes")).status).toBe(200);
    });

    it("bounces /login to the switcher (no auth to perform)", async () => {
      const res = await localApp(null).request("/login");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    });
  });

  describe("token configured", () => {
    it("redirects an unauthenticated web page to /login with a next param", async () => {
      const res = await localApp(TOKEN).request("/me/notes");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/me/notes")}`);
    });

    it("401s an unauthenticated API call", async () => {
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main");
      expect(res.status).toBe(401);
    });

    it("accepts a correct Bearer token on the API", async () => {
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it("accepts the cosheaf_wb cookie on a web page", async () => {
      const res = await localApp(TOKEN).request("/me/notes", { headers: { cookie: `cosheaf_wb=${TOKEN}` } });
      expect(res.status).toBe(200);
    });

    it("rejects a wrong same-length token without throwing", async () => {
      const wrong = "x".repeat(TOKEN.length);
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main", {
        headers: { authorization: `Bearer ${wrong}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a wrong different-length token without throwing", async () => {
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main", {
        headers: { authorization: "Bearer short" },
      });
      expect(res.status).toBe(401);
    });

    it("leaves /login, health, and origin reachable unauthenticated", async () => {
      const app = localApp(TOKEN);
      expect((await app.request("/login")).status).toBe(200);
      expect((await app.request("/api/v1/health")).status).toBe(200);
      expect((await app.request("/api/v1/origin")).status).toBe(200);
    });

    it("sets the cookie on a correct POST /login and redirects to next", async () => {
      const res = await localApp(TOKEN).request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
        body: new URLSearchParams({ token: TOKEN, next: "/me/notes" }).toString(),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/me/notes");
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => /^cosheaf_wb=/.test(c) && /HttpOnly/i.test(c))).toBe(true);
    });

    it("redirects a wrong POST /login back to the form with an error", async () => {
      const res = await localApp(TOKEN).request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
        body: new URLSearchParams({ token: "nope", next: "/me/notes" }).toString(),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/login?error=1");
      expect(res.headers.getSetCookie()).toHaveLength(0);
    });

    it("does not honor an off-site next (no open redirect, incl. backslash vector)", async () => {
      for (const next of ["//evil.example/", "/\\evil.example", "/\\/evil.example", "https://evil.example"]) {
        const res = await localApp(TOKEN).request("/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
          body: new URLSearchParams({ token: TOKEN, next }).toString(),
        });
        expect(res.headers.get("location")).toBe("/");
      }
    });

    it("marks the cookie Secure when behind an https proxy (X-Forwarded-Proto)", async () => {
      const res = await localApp(TOKEN).request("/login", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
          "x-forwarded-proto": "https",
        },
        body: new URLSearchParams({ token: TOKEN, next: "/" }).toString(),
      });
      expect(res.headers.getSetCookie().some((c) => /^cosheaf_wb=/.test(c) && /Secure/i.test(c))).toBe(true);
    });

    it("omits Secure on a plain-http (loopback) login", async () => {
      const res = await localApp(TOKEN).request("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
        body: new URLSearchParams({ token: TOKEN, next: "/" }).toString(),
      });
      expect(res.headers.getSetCookie().some((c) => /^cosheaf_wb=/.test(c) && /Secure/i.test(c))).toBe(false);
    });
  });
});

describe("refuseRemoteWithoutToken", () => {
  it("allows loopback with no token", () => {
    expect(refuseRemoteWithoutToken("127.0.0.1", null)).toBeNull();
    expect(refuseRemoteWithoutToken("localhost", null)).toBeNull();
    expect(refuseRemoteWithoutToken("::1", null)).toBeNull();
  });

  it("allows a non-loopback host when a token is set", () => {
    expect(refuseRemoteWithoutToken("0.0.0.0", "tok")).toBeNull();
    expect(refuseRemoteWithoutToken("10.0.0.5", "tok")).toBeNull();
  });

  it("refuses a non-loopback host with no token", () => {
    expect(refuseRemoteWithoutToken("0.0.0.0", null)).toMatch(/refusing to bind/);
    expect(refuseRemoteWithoutToken("192.168.1.10", null)).toMatch(/COSHEAF_WORKBENCH_TOKEN/);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes loopback addresses", () => {
    for (const h of ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects non-loopback addresses", () => {
    for (const h of ["0.0.0.0", "::", "10.0.0.1", "192.168.1.2", "example.com"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
