import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ForgejoError } from "../forgejo.js";
import type { AppEnv } from "../types.js";
import { handleAppError } from "./error-handler.js";

function appThrowing(status: number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(handleAppError);
  app.use("*", async (c, next) => {
    c.set("user", { username: "chao" });
    await next();
  });
  app.get("/api/v1/w/w/issues", () => {
    throw new ForgejoError(status, "boom", "GET", "/x");
  });
  app.get("/owner/repo/issues", () => {
    throw new ForgejoError(status, "boom", "GET", "/x");
  });
  return app;
}

describe("handleAppError", () => {
  it("maps Forgejo 404 to the typed envelope on /api", async () => {
    const res = await appThrowing(404).request("/api/v1/w/w/issues");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: "not_found" });
  });

  it("maps Forgejo 403 to forbidden on /api", async () => {
    const res = await appThrowing(403).request("/api/v1/w/w/issues");
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "forbidden" });
  });

  it("maps other Forgejo failures to bad_gateway on /api", async () => {
    const res = await appThrowing(500).request("/api/v1/w/w/issues");
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: "bad_gateway" });
  });

  it("keeps the pat_invalid contract for Forgejo 401 on /api", async () => {
    const res = await appThrowing(401).request("/api/v1/w/w/issues");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: "pat_invalid" });
  });

  it("renders HTML error pages on web routes", async () => {
    const notFound = await appThrowing(404).request("/owner/repo/issues");
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("content-type")).toContain("text/html");

    const forbidden = await appThrowing(403).request("/owner/repo/issues");
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("content-type")).toContain("text/html");

    const gateway = await appThrowing(500).request("/owner/repo/issues");
    expect(gateway.status).toBe(502);
    expect(gateway.headers.get("content-type")).toContain("text/html");
  });

  it("sends web sessions with a rejected token back to login", async () => {
    const res = await appThrowing(401).request("/owner/repo/issues");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("rethrows non-Forgejo errors", async () => {
    const app = new Hono<AppEnv>();
    app.onError(async (err, c) => {
      try {
        return await handleAppError(err, c);
      } catch (rethrown) {
        return c.text(`rethrown: ${(rethrown as Error).message}`, 500);
      }
    });
    app.get("/x", () => {
      throw new Error("plain failure");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    await expect(res.text()).resolves.toBe("rethrown: plain failure");
  });
});
