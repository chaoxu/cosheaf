import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { origin } from "./origin.js";
import { freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("origin");

function freshDb(): Database.Database {
  return freshTestDb("cosheaf-origin-");
}

function appFor(db: Database.Database, appConfig = config) {
  return testApp(db, appConfig, (app) => app.route("/api/v1", origin));
}

describe("GET /api/v1/origin", () => {
  it("serves the Cosheaf Origin API capability manifest", async () => {
    const db = freshDb();
    const res = await appFor(db, testConfig("origin-public", { publicOrigin: "https://cosheaf.test" }))
      .request("/api/v1/origin", { headers: { host: "127.0.0.1:3030" } });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      origin_id: string;
      display_name: string;
      server_url: string;
      api_version: string;
      auth_schemes: Array<{ id: string; type: string; cookie_name?: string; scheme?: string }>;
      capabilities: Array<{ id: string; route_prefix: string }>;
      document_formats: Array<{ id: string; display_name: string; extensions: string[] }>;
      consistency: Record<string, string>;
    };
    expect(body).toMatchObject({
      origin_id: "https://cosheaf.test",
      display_name: "Cosheaf",
      server_url: "https://cosheaf.test",
      api_version: "v1",
    });
    expect(body.auth_schemes).toEqual([
      expect.objectContaining({ id: "cookie", type: "cookie", cookie_name: "cosheaf_pat", same_origin: true }),
      expect.objectContaining({ id: "bearer", type: "http", header: "Authorization", scheme: "Bearer" }),
      expect.objectContaining({ id: "token", type: "http", header: "Authorization", scheme: "token" }),
    ]);
    expect(body.capabilities.map((capability) => capability.id)).toEqual([
      "auth",
      "workspaces",
      "repo_metadata",
      "files",
      "branches",
      "pulls",
      "reviews",
      "issues",
      "labels",
      "milestones",
      "notifications",
      "events",
      "search",
      "diagnostics",
      "document_formats",
    ]);
    expect(body.document_formats).toEqual([
      { id: "coflat", display_name: "Coflat Markdown", extensions: [".md"] },
    ]);
    expect(body.consistency.branch_reads).toContain("requested Forgejo branch");
    expect(body.consistency.main_index).toContain("may lag");
  });

  it("falls back to the request origin when publicOrigin is not configured", async () => {
    const db = freshDb();
    const res = await appFor(db).request("http://dev.cosheaf.test/api/v1/origin");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      origin_id: "http://dev.cosheaf.test",
      server_url: "http://dev.cosheaf.test",
    });
  });

  it("is mounted by the assembled app without auth or self-HTTP dependencies", async () => {
    const db = freshDb();
    const app = createApp({ config, db });
    const res = await app.request("/api/v1/origin");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      api_version: "v1",
      display_name: "Cosheaf",
    });
  });
});
