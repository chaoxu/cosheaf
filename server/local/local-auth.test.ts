import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig, isLoopbackHost, refuseRemoteWithoutToken } from "../db.js";
import { freshTestDb, testLocalRegistry } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { hostHeaderName } from "./local-auth.js";

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
function localApp(accessToken: string | null, publicOrigin: string | null = null): Hono<AppEnv> {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-auth-"));
  writeFileSync(join(dir, "hello.md"), "# Hello\n");
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0, accessToken, publicOrigin });
  const db = freshTestDb("cosheaf-local-auth-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  return createApp({ config, db, localRegistry: testLocalRegistry(db, backend, IDENTITY) });
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

    it("rejects a non-loopback Host header to block DNS rebinding reads", async () => {
      const res = await localApp(null).request("/api/v1/repos/me/notes/tree?branch=main", {
        headers: { host: "attacker.example:3030", origin: "http://attacker.example:3030" },
      });
      expect(res.status).toBe(403);
    });

    it("accepts loopback Host header forms in no-token mode", async () => {
      const app = localApp(null);
      for (const host of ["localhost:3030", "127.0.0.1:3030", "127.0.0.2", "[::1]:3030"]) {
        const res = await app.request("/api/v1/repos/me/notes/tree?branch=main", { headers: { host } });
        expect(res.status, host).toBe(200);
      }
    });

    it("renders no Sign out link when there is no token", async () => {
      const res = await localApp(null).request("/");
      expect(await res.text()).not.toContain('data-testid="workbench-signout"');
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

    it("401s an unauthenticated API call with code:unauthorized (so the island bounces to /login)", async () => {
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main");
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe("unauthorized");
    });

    it("renders a Sign out link in the switcher chrome when token auth is on", async () => {
      const res = await localApp(TOKEN).request("/", { headers: { cookie: `cosheaf_wb=${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('data-testid="workbench-signout"');
    });

    it("logout clears the cookie and bounces to /login", async () => {
      const res = await localApp(TOKEN).request("/logout", { headers: { cookie: `cosheaf_wb=${TOKEN}` } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/login");
      expect(res.headers.getSetCookie().some((c) => /^cosheaf_wb=/.test(c) && /Max-Age=0|Expires=/i.test(c))).toBe(true);
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

    it("allows a non-loopback Host when the shared token is configured and presented", async () => {
      const res = await localApp(TOKEN).request("/api/v1/repos/me/notes/tree?branch=main", {
        headers: { host: "wb.example:3030", authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });
  });
});

describe("COSHEAF_PUBLIC_ORIGIN (exposure behind a TLS proxy)", () => {
  const PUB = "https://wb.example";
  // A cross-origin (scheme-mismatched) mutation as a browser behind an https
  // proxy sends it: Origin https://wb.example while the server runs plain http.
  function mutate(app: Hono<AppEnv>) {
    return app.request("/api/v1/repos/me/notes/branches", {
      method: "POST",
      headers: { "content-type": "application/json", origin: PUB, host: "wb.example", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "wip-x", from: "main" }),
    });
  }

  it("without a public origin, an https-proxied write is wrongly 403'd by the CSRF guard", async () => {
    // Documents the failure mode the option fixes: requestOrigin sees plain http.
    expect((await mutate(localApp(TOKEN, null))).status).toBe(403);
  });

  it("with the public origin set, the same https write passes the CSRF guard", async () => {
    expect((await mutate(localApp(TOKEN, PUB))).status).not.toBe(403);
  });

  it("derives the cookie Secure flag from the public origin (no X-Forwarded-Proto needed)", async () => {
    const res = await localApp(TOKEN, PUB).request("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUB },
      body: new URLSearchParams({ token: TOKEN, next: "/" }).toString(),
    });
    expect(res.headers.getSetCookie().some((c) => /^cosheaf_wb=/.test(c) && /Secure/i.test(c))).toBe(true);
  });
});

describe("local Workbench /origin manifest", () => {
  it("describes a federated, local-git provider (no native collaboration)", async () => {
    const res = await localApp(null).request("/api/v1/origin");
    const body = (await res.json()) as {
      display_name: string;
      provider: { content: string; collaboration: string };
      capabilities: Array<{ id: string }>;
      auth_schemes: Array<{ id: string; type: string }>;
      consistency: { source_of_truth: string };
    };
    expect(body.display_name).toBe("Cosheaf Workbench");
    expect(body.provider).toEqual({ content: "local-git", collaboration: "federated" });
    const ids = body.capabilities.map((cap) => cap.id);
    expect(ids).toContain("files");
    expect(ids).toContain("branches");
    expect(ids).not.toContain("issues");
    expect(ids).not.toContain("reviews");
    expect(body.consistency.source_of_truth).toMatch(/local git working tree/i);
    expect(body.auth_schemes).toEqual([expect.objectContaining({ id: "none", type: "none" })]);
  });

  it("advertises the workbench cookie + bearer auth schemes when a token is set", async () => {
    const res = await localApp(TOKEN).request("/api/v1/origin");
    const body = (await res.json()) as { auth_schemes: Array<{ id: string; cookie_name?: string }> };
    expect(body.auth_schemes.map((s) => s.id)).toEqual(["cookie", "bearer"]);
    expect(body.auth_schemes[0].cookie_name).toBe("cosheaf_wb");
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
  it("recognizes the whole loopback block and IPv4-mapped loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", "localhost", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects non-loopback addresses (stays strict in the dangerous direction)", () => {
    for (const h of ["0.0.0.0", "::", "10.0.0.1", "192.168.1.2", "128.0.0.1", "27.0.0.1", "example.com", "::ffff:10.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("hostHeaderName", () => {
  it("extracts a hostname from normal Host header forms", () => {
    expect(hostHeaderName("localhost:3030")).toBe("localhost");
    expect(hostHeaderName("127.0.0.1")).toBe("127.0.0.1");
    expect(hostHeaderName("[::1]:3030")).toBe("::1");
  });

  it("rejects malformed or blank Host headers", () => {
    expect(hostHeaderName("")).toBeNull();
    expect(hostHeaderName("[::1")).toBeNull();
  });
});
