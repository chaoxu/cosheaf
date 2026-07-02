import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../shared/document-format.js";
import { resolveAppRoot, resolveCoflatDistDir } from "./app-root.js";
import { createApp } from "./app.js";
import { buildLocalConfig } from "./db.js";
import { LocalGitWorkspaceBackend } from "./local/local-git-backend.js";
import { freshTestDb, testLocalRegistry } from "./routes/test-fixtures.js";
import type { LocalWorkspaceIdentity } from "./types.js";

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
};

describe("resolveAppRoot", () => {
  afterEach(() => {
    delete process.env.COSHEAF_APP_ROOT;
  });

  it("returns the resolved COSHEAF_APP_ROOT when set", () => {
    process.env.COSHEAF_APP_ROOT = "/tmp/some/bundle";
    expect(resolveAppRoot()).toBe("/tmp/some/bundle");
  });

  it("falls back to process.cwd() in a repo checkout (no env)", () => {
    expect(resolveAppRoot()).toBe(process.cwd());
  });
});

describe("resolveCoflatDistDir", () => {
  it("prefers a vendored coflat dist when <appRoot>/vendor/coflat/editor.css exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cosheaf-approot-"));
    mkdirSync(join(root, "vendor", "coflat"), { recursive: true });
    writeFileSync(join(root, "vendor", "coflat", "editor.css"), "/* vendored */");
    expect(resolveCoflatDistDir(root, () => "/should/not/be/called/editor.css")).toBe(join(root, "vendor", "coflat"));
  });

  it("falls back to the node_modules resolver when nothing is vendored", () => {
    const root = mkdtempSync(join(tmpdir(), "cosheaf-approot-"));
    expect(resolveCoflatDistDir(root, () => "/node_modules/@chaoxu/coflat/dist/style.css")).toBe(
      "/node_modules/@chaoxu/coflat/dist",
    );
  });
});

describe("bundled-root asset serving (COSHEAF_APP_ROOT)", () => {
  afterEach(() => {
    delete process.env.COSHEAF_APP_ROOT;
  });

  it("serves top-level public assets from the relocated app root, not cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "cosheaf-bundle-root-"));
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "relocated.css"), "/* RELOCATED */");
    process.env.COSHEAF_APP_ROOT = root;

    const work = mkdtempSync(join(tmpdir(), "cosheaf-bundle-work-"));
    const config = buildLocalConfig({ dataDir: join(work, ".cosheaf"), port: 0 });
    const db = freshTestDb("cosheaf-approot-db-");
    const backend = new LocalGitWorkspaceBackend(work);
    const app = createApp({
      config,
      db,
      localRegistry: testLocalRegistry(db, backend, IDENTITY),
    });

    const res = await app.request("/relocated.css");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("RELOCATED");
  });
});
