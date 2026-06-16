import type Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types.js";
import { web } from "./web.js";
import { freshTestDb, testApp, testConfig } from "./test-fixtures.js";

const config = testConfig("web-i18n");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => app.route("/", web));
}

function get(db: Database.Database, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(appFor(db).request("/login", { headers }));
}

describe("UI locale resolution on the login page", () => {
  it("defaults to English (lang=en, English chrome)", async () => {
    const body = await (await get(freshTestDb())).text();
    expect(body).toContain('lang="en"');
    expect(body).toContain('dir="ltr"');
    expect(body).toContain('data-cosheaf-locale="en"');
    expect(body).toContain("Sign in");
  });

  it("renders Chinese when the cosheaf_lang cookie is zh", async () => {
    const body = await (await get(freshTestDb(), { cookie: "cosheaf_lang=zh" })).text();
    expect(body).toContain('lang="zh"');
    expect(body).toContain('data-cosheaf-locale="zh"');
    expect(body).toContain("登录"); // Sign in
    expect(body).toContain("用户名"); // Username
    expect(body).toContain("密码"); // Password
    expect(body).not.toContain(">Sign in<");
  });

  it("negotiates Chinese from Accept-Language when no cookie is set", async () => {
    const body = await (await get(freshTestDb(), { "accept-language": "zh-CN,zh;q=0.9,en;q=0.4" })).text();
    expect(body).toContain('lang="zh"');
    expect(body).toContain("登录");
  });

  it("the explicit cookie wins over Accept-Language", async () => {
    const body = await (
      await get(freshTestDb(), { cookie: "cosheaf_lang=en", "accept-language": "zh-CN,zh;q=0.9" })
    ).text();
    expect(body).toContain('lang="en"');
    expect(body).toContain("Sign in");
  });

  it("ignores an unsupported cookie value and falls through to the default", async () => {
    const body = await (await get(freshTestDb(), { cookie: "cosheaf_lang=fr" })).text();
    expect(body).toContain('lang="en"');
  });
});
