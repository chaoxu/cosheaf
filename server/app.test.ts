import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { seedAuthUser } from "./test-helpers.js";
import { freshTestDb, testConfig } from "./routes/test-fixtures.js";

describe("createApp API route assembly", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("does not expose git-over-HTTPS clone endpoints from Cosheaf", async () => {
    const config = testConfig("app-assembly");
    const db = freshTestDb("cosheaf-app-assembly-");
    const app = createApp({ config, db });

    const res = await app.request("/owner/repo.git/info/refs?service=git-upload-pack", {
      headers: { authorization: `Basic ${Buffer.from("git:token").toString("base64")}` },
    });

    expect(res.status).toBe(404);
  });

  it("proxies Vite file-system asset URLs in development", async () => {
    const config = testConfig("app-assembly");
    const db = freshTestDb("cosheaf-app-assembly-");
    const app = createApp({ config, db });
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      new Response("font", {
        status: 200,
        headers: { "content-type": "font/woff2" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/@fs/Users/example/node_modules/@chaoxu/coflat/dist/fonts/KaTeX_Main-Regular.woff2");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(await res.text()).toBe("font");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:5173/@fs/Users/example/node_modules/@chaoxu/coflat/dist/fonts/KaTeX_Main-Regular.woff2",
    );
  });

  it("serves the current Coflat document-surface CSS contract", async () => {
    const config = testConfig("app-coflat-css");
    const db = freshTestDb("cosheaf-app-coflat-css-");
    const app = createApp({ config, db });

    const res = await app.request("/vendor/coflat/document-surface.css?v=test");

    expect(res.status).toBe(200);
    const css = await res.text();
    expect(css).toContain(".cf-doc-heading[data-section-number]::before");
    expect(css).not.toMatch(/(^|})\s*\[data-section-number\]::before/);
    expect(css).not.toContain("cf-section-number");

    const editorRes = await app.request("/vendor/coflat/editor.css?v=test");
    expect(editorRes.status).toBe(200);

    const themeRes = await app.request("/vendor/coflat/themes/blueprint-book.css?v=test");
    expect(themeRes.status).toBe(200);
    expect(await themeRes.text()).toContain(".cf-theme-blueprint-book");
  });
});
