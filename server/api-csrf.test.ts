import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Config } from "./db.js";
import { rejectCrossOriginCookieApiMutation } from "./api-csrf.js";
import { requireAuth } from "./middleware.js";
import { seedAuthUser } from "./test-helpers.js";
import type { AppEnv } from "./types.js";
import { freshTestDb } from "./routes/test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-api-csrf-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "runtime-token",
  forgejoAdminToken: "admin-token",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  publicOrigin: "https://cosheaf.lab",
  registrationOpen: false,
  trustedProxyHops: 0,
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
};

function appFor() {
  const db = freshTestDb("cosheaf-api-csrf-");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    await next();
  });
  app.use("/api/v1/*", rejectCrossOriginCookieApiMutation);
  app.post("/api/v1/probe", requireAuth, (c) => c.json({ ok: true, user: c.get("user").username }));
  return { app, db };
}

describe("rejectCrossOriginCookieApiMutation", () => {
  it("rejects cross-origin cookie-authenticated API mutations", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: { cookie: `cosheaf_pat=${token}`, origin: "https://evil.test" },
    });

    expect(res.status).toBe(403);
  });

  it("allows same-origin cookie-authenticated API mutations", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: { cookie: `cosheaf_pat=${token}`, origin: "https://cosheaf.lab" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: "alice" });
  });

  it("rejects originless cookie-authenticated API mutations", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: { cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(403);
  });

  it("does not let an empty Bearer header turn cookie auth into bearer auth", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: { authorization: "Bearer ", cookie: `cosheaf_pat=${token}` },
    });

    expect(res.status).toBe(403);
  });

  it("allows originless bearer API mutations", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "alice" });

    const res = await app.request("/api/v1/probe", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: "alice" });
  });
});
