import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";

const IDENTITY: LocalWorkspaceIdentity = {
  owner: "me",
  repo: "notes",
  defaultMdFormat: COFLAT_FORMAT_ID,
  user: "me",
  title: "notes",
  canOpenPull: false,
};

function localApp(seed: Record<string, string> = {}): { app: Hono<AppEnv>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-app-"));
  for (const [path, content] of Object.entries(seed)) writeFileSync(join(dir, path), content);
  const config = buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 });
  const db = freshTestDb("cosheaf-local-app-db-");
  const backend = new LocalGitWorkspaceBackend(dir);
  const app = createApp({ config, db, workspaceBackend: backend, localWorkspace: IDENTITY });
  return { app, dir };
}

describe("local Workbench app (Tier 0)", () => {
  it("serves the file API for the working tree with no auth", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; sha: string };
    expect(body.content).toBe("# Hello\n");
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists the working tree via the tree route", async () => {
    const { app } = localApp({ "a.md": "# A\n", "b.md": "# B\n" });
    const res = await app.request("/api/v1/repos/me/notes/tree?branch=main");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("writes a file to disk through PUT /file on main (direct mode)", async () => {
    const { app, dir } = localApp({ "hello.md": "# Hello\n" });
    const read = (await (await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main")).json()) as { sha: string };
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Changed\n", expected_sha: read.sha }),
    });
    expect(res.status).toBe(200);
    const onDisk = readFileSync(join(dir, "hello.md"), "utf8");
    expect(onDisk).toContain("# Changed");
    // Coflat markdown gets a frontmatter id stamped on write.
    expect(onDisk).toMatch(/id:/);
  });

  it("rejects a stale-sha write with a conflict", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/me/notes/file?path=hello.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Changed\n", expected_sha: "0000000000000000000000000000000000000000" }),
    });
    expect(res.status).toBe(409);
  });

  it("404s a workspace that is not the one this Workbench serves", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/api/v1/repos/someone/else/file?path=hello.md&branch=main");
    expect(res.status).toBe(404);
  });

  it("redirects home to the single workspace landing", async () => {
    const { app } = localApp();
    const res = await app.request("/");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/me/notes");
  });

  it("renders the edit page in direct write-mode with PR affordances off", async () => {
    const { app } = localApp({ "hello.md": "# Hello\n" });
    const res = await app.request("/me/notes/src/branch/main/hello.md?mode=edit");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-write-mode="direct"');
    expect(body).toContain('data-can-open-pull="0"');
    expect(body).toContain('data-branch="main"');
  });
});
