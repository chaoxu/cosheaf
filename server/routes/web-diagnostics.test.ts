import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { indexPage } from "../indexer.js";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerDiagnosticsRoutes } from "./web-diagnostics.js";

const config = testConfig("web-diagnostics");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => registerDiagnosticsRoutes(app));
}

function authHeaders(token: string): Record<string, string> {
  return { cookie: `cosheaf_pat=${token}` };
}

describe("web diagnostics route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders broken refs, duplicate labels, and unreferenced ids", async () => {
    const db = freshTestDb("cosheaf-web-diagnostics-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "read" });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "source.md",
      bodyText: "---\nid: source\n---\n# Source\n\nSee [@missing].\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "a.md",
      bodyText: "---\nid: a\n---\n# A\n\n::: {#thm:dup .theorem}\nA.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "b.md",
      bodyText: "---\nid: b\n---\n# B\n\n::: {#thm:dup .theorem}\nB.\n:::\n",
      formatId: COFLAT_FORMAT_ID,
    });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("not found", { status: 404 }));
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
    }));

    const res = await appFor(db).request("/owner/w/diagnostics", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="diagnostics-summary"');
    expect(body).toContain('data-testid="diagnostics-broken-refs"');
    expect(body).toContain("missing");
    expect(body).toContain('data-testid="diagnostics-duplicate-xrefs"');
    expect(body).toContain("thm:dup");
    expect(body).toContain('data-testid="diagnostics-orphan-labels"');
    expect(body).toContain("Unreferenced Page Ids");
  });
});
