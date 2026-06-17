import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { seedAuthUser } from "./test-helpers.js";
import { freshTestDb, testConfig } from "./routes/test-fixtures.js";

describe("createApp API route assembly", () => {
  it("mounts the cookie API CSRF guard before typed API mutations", async () => {
    const config = testConfig("app-assembly");
    const db = freshTestDb("cosheaf-app-assembly-");
    const app = createApp({ config, db });
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `cosheaf_pat=${token}`,
        origin: "http://evil.test",
        host: "localhost",
      },
      body: JSON.stringify({ slug: "notes", name: "Notes" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("keeps same-origin API logout working through the assembled guard chain", async () => {
    const config = testConfig("app-assembly");
    const db = freshTestDb("cosheaf-app-assembly-");
    const app = createApp({ config, db });
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/logout", {
      method: "POST",
      headers: {
        cookie: `cosheaf_pat=${token}`,
        origin: "http://localhost",
        host: "localhost",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain("cosheaf_pat=");
  });
});
