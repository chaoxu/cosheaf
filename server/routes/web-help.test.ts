import type Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { freshTestDb, testApp, testConfig } from "./test-fixtures.js";
import { web } from "./web.js";

const config = testConfig("web-help");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/", web));
}

describe("GET /help", () => {
  it("requires sign in", async () => {
    const db = freshTestDb("cosheaf-help-");
    const res = await appFor(db).request("/help");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("renders the user-facing Cosheaf guide", async () => {
    const db = freshTestDb("cosheaf-help-");
    const token = seedAuthUser(db, config, { username: "alice" });
    const res = await appFor(db).request("/help", { headers: { cookie: `cosheaf_pat=${token}` } });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="help-page"');
    expect(body).toContain("How Cosheaf works");
    expect(body).toContain("Use it like a focused repository");
    expect(body).toContain("A pull request is the review record for a branch.");
    expect(body).toContain('class="help-circle active" href="/help"');
  });
});
