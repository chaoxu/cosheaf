import { Hono } from "hono";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../db.js";
import { Forgejo } from "../forgejo.js";
import {
  _resetBearerAuthCacheForTests,
  _resetFormatCacheForTests,
  _resetPermCacheForTests,
} from "../middleware.js";
import { SSEHub } from "../sse.js";
import { seedAuthUser } from "../test-helpers.js";
import type { AppEnv } from "../types.js";
import { workspaces } from "./workspaces.js";
import { freshTestDb } from "./test-fixtures.js";
import { responseEmpty, responseOk } from "./test-fixtures.js";

const config: Config = {
  dataDir: "/tmp/cosheaf-workspaces-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "admin-token",
  forgejoOwner: "owner",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
};

function appFor() {
  const db = freshTestDb("cosheaf-workspaces-");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("fjAdmin", new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken }));
    c.set("sse", new SSEHub());
    await next();
  });
  app.route("/api/v1/workspaces", workspaces);
  return { app, db };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  _resetBearerAuthCacheForTests();
  _resetPermCacheForTests();
  _resetFormatCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/v1/workspaces", () => {
  it("lists repos under the owner that carry a cosheaf-format-* topic and derives role from inline permissions", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    // listUserRepos returns four candidates: one coflat (admin), one
    // passthrough (write-only), one random repo with no cosheaf topic,
    // one cosheaf-tagged but with no access.
    fetchMock.mockImplementationOnce(async () =>
      responseOk([
        {
          id: 1, name: "alpha", full_name: "owner/alpha", default_branch: "main",
          description: "Alpha workspace", owner: { id: 1, login: "owner" },
          topics: ["cosheaf-format-coflat"],
          permissions: { admin: true, push: true, pull: true },
        },
        {
          id: 2, name: "beta", full_name: "owner/beta", default_branch: "main",
          description: "Beta", owner: { id: 1, login: "owner" },
          topics: ["cosheaf-format-forgejo-passthrough"],
          permissions: { admin: false, push: true, pull: true },
        },
        {
          id: 3, name: "untagged", full_name: "owner/untagged", default_branch: "main",
          owner: { id: 1, login: "owner" },
          topics: ["unrelated"],
          permissions: { admin: true, push: true, pull: true },
        },
        {
          id: 4, name: "private", full_name: "owner/private", default_branch: "main",
          owner: { id: 1, login: "owner" },
          topics: ["cosheaf-format-coflat"],
          permissions: {},
        },
      ]),
    );

    const res = await app.request("/api/v1/workspaces", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ slug: string; name: string; role: string; default_md_format: string }> };
    expect(body.workspaces).toEqual([
      { slug: "alpha", name: "Alpha workspace", role: "admin", default_md_format: "coflat" },
      { slug: "beta", name: "Beta", role: "write", default_md_format: "forgejo-passthrough" },
    ]);
  });

  it("requires a bearer token", async () => {
    const { app } = appFor();
    const res = await app.request("/api/v1/workspaces");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/workspaces", () => {
  it("creates a workspace and writes the cosheaf-format topic", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });

    let topicPutBody: unknown = null;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      // existence pre-check: repo does not yet exist
      if (url.endsWith("/api/v1/repos/owner/new-ws") && method === "GET") {
        return new Response("", { status: 404 });
      }
      if (url.endsWith("/api/v1/user/repos") && method === "POST") {
        return responseOk({
          id: 99, name: "new-ws", full_name: "owner/new-ws",
          default_branch: "main", description: "New workspace",
          owner: { id: 1, login: "owner" },
        });
      }
      if (url.endsWith("/api/v1/repos/owner/new-ws/topics") && method === "GET") {
        return responseOk({ topics: [] });
      }
      if (url.endsWith("/api/v1/repos/owner/new-ws/topics") && method === "PUT") {
        topicPutBody = init?.body ? JSON.parse(String(init.body)) : null;
        return responseEmpty(204);
      }
      // permissions / branch protection / hooks / .gitattributes / reindex tree
      if (url.includes("/collaborators/")) return responseEmpty(204);
      if (url.includes("/branch_protections")) return responseOk({});
      if (url.includes("/hooks")) {
        return method === "GET" ? responseOk([]) : responseOk({ id: 1, type: "forgejo", events: ["push"] });
      }
      if (url.includes("/contents/")) {
        return method === "GET" ? new Response("", { status: 404 }) : responseOk({});
      }
      if (url.includes("/git/trees/main")) return responseOk({ tree: [] });
      return responseOk({});
    });

    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "new-ws", name: "New workspace" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; name: string; default_md_format: string };
    expect(body.slug).toBe("new-ws");
    expect(body.name).toBe("New workspace");
    expect(body.default_md_format).toBe("forgejo-passthrough");
    expect(topicPutBody).toEqual({ topics: ["cosheaf-format-forgejo-passthrough"] });
  });

  it("rejects an invalid slug", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "Bad Slug!", name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the slug already exists in Forgejo", async () => {
    const { app, db } = appFor();
    const token = seedAuthUser(db, config, { username: "chao" });
    fetchMock.mockImplementation(async () =>
      responseOk({
        id: 5, name: "taken", full_name: "owner/taken",
        default_branch: "main", description: "",
        owner: { id: 1, login: "owner" },
      }),
    );
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "taken", name: "Taken" }),
    });
    expect(res.status).toBe(409);
  });
});
