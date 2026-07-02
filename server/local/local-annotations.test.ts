import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { _resetPdfExportLimiterForTest } from "../pdf-export.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import { type SSEEvent, SSEHub } from "../sse.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { localAnchorPreflightIssues } from "./local-annotations.js";
import type { WorkspaceEntry } from "./workspace-registry.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function workspace(options: { sse?: SSEHub } = {}): { dir: string; app: Hono<AppEnv> } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-annotations-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Tester"]);
  writeFileSync(join(dir, "paper.md"), "# Paper\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);

  const identity: LocalWorkspaceIdentity = {
    owner: "me",
    repo: "paper",
    defaultMdFormat: COFLAT_FORMAT_ID,
    user: "chao",
    title: "paper",
    canOpenPull: false,
  };
  const db = freshTestDb("local-annotations-");
  const registry = new WorkspaceRegistry(db, { user: identity.user });
  registry.register({
    slug: workspaceSlug(identity.owner, identity.repo),
    path: dir,
    identity,
    backend: new LocalGitWorkspaceBackend(dir),
    remote: null,
    gitRemote: null,
  });
  return {
    dir,
    app: createApp({
      config: buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 }),
      db,
      localRegistry: registry,
      sse: options.sse,
    }),
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe("local Workbench annotations", () => {
  afterEach(() => {
    _resetPdfExportLimiterForTest();
  });

  it("creates, lists, updates, appends, and deletes local annotations", async () => {
    const { dir, app } = workspace();
    const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ kind: "task", path: "paper.md", body: "Clarify the reduction.", author: "chao" }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await json(createdRes)).annotation as Record<string, unknown>;
    expect(created.kind).toBe("task");
    expect(created.status).toBe("open");
    expect(created.path).toBe("paper.md");
    expect(created.anchor).toBe(`[@local:${created.id}]`);

    const storedPath = join(dir, ".cosheaf", "local-annotations.json");
    expect(existsSync(storedPath)).toBe(true);
    expect(JSON.parse(readFileSync(storedPath, "utf8")).annotations[created.id as string]).toBeTruthy();

    const listRes = await app.request("/api/v1/repos/me/paper/local-annotations?status=open&path=paper.md");
    expect(listRes.status).toBe(200);
    expect(((await json(listRes)).annotations as unknown[])).toHaveLength(1);

    const patchRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await json(patchRes)).annotation as Record<string, unknown>).status).toBe("resolved");

    const messageRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ body: "Done in the intro.", author: "codex" }),
    });
    expect(messageRes.status).toBe(200);
    const updated = (await json(messageRes)).annotation as { messages: unknown[] };
    expect(updated.messages).toHaveLength(2);

    const deleteRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}`, {
      method: "DELETE",
      headers: { origin: "http://localhost" },
    });
    expect(deleteRes.status).toBe(200);
    expect(await json(deleteRes)).toEqual({ ok: true });

    const afterDelete = JSON.parse(readFileSync(storedPath, "utf8")) as { annotations: Record<string, unknown> };
    expect(afterDelete.annotations[created.id as string]).toBeUndefined();
  });

  it("publishes local annotation events after successful API mutations", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/paper", (event) => events.push(event));
    const { app } = workspace({ sse });

    try {
      const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ kind: "task", path: "paper.md", body: "Clarify the reduction.", author: "chao" }),
      });
      expect(createdRes.status).toBe(201);
      const created = (await json(createdRes)).annotation as Record<string, string>;

      const messageRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ body: "Agent checked this.", author: "codex" }),
      });
      expect(messageRes.status).toBe(200);

      const patchRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ status: "resolved", path: "renamed.md" }),
      });
      expect(patchRes.status).toBe(200);

      const deleteRes = await app.request(`/api/v1/repos/me/paper/local-annotations/${created.id}`, {
        method: "DELETE",
        headers: { origin: "http://localhost" },
      });
      expect(deleteRes.status).toBe(200);

      expect(events).toEqual([
        { type: "annotations_changed", action: "created", id: created.id, path: "paper.md" },
        { type: "annotations_changed", action: "message", id: created.id, path: "paper.md" },
        {
          type: "annotations_changed",
          action: "updated",
          id: created.id,
          path: "renamed.md",
          previous_path: "paper.md",
        },
        { type: "annotations_changed", action: "deleted", id: created.id, path: "renamed.md" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("rejects unsafe document paths", async () => {
    const { app } = workspace();
    const res = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "../paper.md", body: "bad" }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "path required" });
  });

  it("rejects unsafe annotation list filters", async () => {
    const { app } = workspace();
    const res = await app.request("/api/v1/repos/me/paper/local-annotations?path=../paper.md");
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "invalid path" });
  });

  it("keeps local annotation sidecar out of git status", async () => {
    const { dir, app } = workspace();
    const res = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Local note" }),
    });
    expect(res.status).toBe(201);
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("refuses to overwrite a corrupt annotation sidecar", async () => {
    const { dir, app } = workspace();
    const storedPath = join(dir, ".cosheaf", "local-annotations.json");
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(storedPath, "{not json");

    const createRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Do not erase existing sidecar." }),
    });
    expect(createRes.status).toBe(409);
    expect(await json(createRes)).toEqual({
      error: "local annotations sidecar is invalid",
      details: "local annotations sidecar is not valid JSON",
    });
    expect(readFileSync(storedPath, "utf8")).toBe("{not json");

    const listRes = await app.request("/api/v1/repos/me/paper/local-annotations");
    expect(listRes.status).toBe(409);
  });

  it("blocks local rename before writing when the annotation sidecar is corrupt", async () => {
    const { dir, app } = workspace();
    const storedPath = join(dir, ".cosheaf", "local-annotations.json");
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(storedPath, JSON.stringify({ annotations: { bad: { id: "bad" } } }));

    const renameRes = await app.request("/api/v1/repos/me/paper/file?path=renamed.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        previous_path: "paper.md",
        content: "# Renamed\n",
      }),
    });

    expect(renameRes.status).toBe(409);
    const body = await json(renameRes);
    expect(body.error).toBe("local annotations sidecar is invalid");
    expect(existsSync(join(dir, "paper.md"))).toBe(true);
    expect(existsSync(join(dir, "renamed.md"))).toBe(false);
    expect(readFileSync(storedPath, "utf8")).toContain("\"bad\"");
  });

  it("blocks local rename before dropping malformed nested annotation messages", async () => {
    const { dir, app } = workspace();
    const storedPath = join(dir, ".cosheaf", "local-annotations.json");
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    const corruptSidecar = JSON.stringify({
      annotations: {
        la_aaaaaaaaaaaa: {
          id: "la_aaaaaaaaaaaa",
          kind: "comment",
          status: "open",
          path: "paper.md",
          anchor: "[@local:la_aaaaaaaaaaaa]",
          created_at: "2026-07-02T00:00:00.000Z",
          updated_at: "2026-07-02T00:00:00.000Z",
          messages: [{
            id: "msg_aaaaaaaaaaaa",
            author: "chao",
            created_at: "2026-07-02T00:00:00.000Z",
            body: "",
          }],
        },
      },
    });
    writeFileSync(storedPath, corruptSidecar);

    const renameRes = await app.request("/api/v1/repos/me/paper/file?path=renamed.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        previous_path: "paper.md",
        content: "# Renamed\n",
      }),
    });

    expect(renameRes.status).toBe(409);
    expect(existsSync(join(dir, "paper.md"))).toBe(true);
    expect(existsSync(join(dir, "renamed.md"))).toBe(false);
    expect(readFileSync(storedPath, "utf8")).toBe(corruptSidecar);
  });

  it("exposes unresolved annotations with document context for agents", async () => {
    const { app } = workspace();
    const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Clarify this paragraph." }),
    });
    const created = (await json(createdRes)).annotation as Record<string, unknown>;
    await app.request("/api/v1/repos/me/paper/file?path=paper.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: `# Paper\nClaim needs work. ${created.anchor}\n` }),
    });

    const queueRes = await app.request("/api/v1/repos/me/paper/local-annotations/unresolved?path=paper.md");
    expect(queueRes.status).toBe(200);
    const queue = (await json(queueRes)).annotations as Array<Record<string, unknown>>;
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(created.id);
    expect(queue[0].context).toEqual({
      line: 6,
      excerpt: `# Paper\nClaim needs work. ${created.anchor}`,
      anchor_found: true,
    });
  });

  it("moves annotation sidecar paths when a local file is renamed through the typed file route", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/paper", (event) => events.push(event));
    const { dir, app } = workspace({ sse });
    const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Follow the rename." }),
    });
    const created = (await json(createdRes)).annotation as Record<string, string>;

    const renameRes = await app.request("/api/v1/repos/me/paper/file?path=renamed.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        previous_path: "paper.md",
        content: `# Paper\n\nMoved paragraph. ${created.anchor}\n`,
      }),
    });
    expect(renameRes.status).toBe(200);
    unsubscribe();

    const oldListRes = await app.request("/api/v1/repos/me/paper/local-annotations?path=paper.md");
    expect(oldListRes.status).toBe(200);
    expect((await json(oldListRes)).annotations).toEqual([]);

    const newListRes = await app.request("/api/v1/repos/me/paper/local-annotations?path=renamed.md");
    expect(newListRes.status).toBe(200);
    const annotations = (await json(newListRes)).annotations as Array<Record<string, string>>;
    expect(annotations).toHaveLength(1);
    expect(annotations[0].id).toBe(created.id);
    expect(annotations[0].path).toBe("renamed.md");

    const renamedSource = readFileSync(join(dir, "renamed.md"), "utf8");
    expect(localAnchorPreflightIssues({ path: dir } as WorkspaceEntry, "renamed.md", renamedSource))
      .toEqual([{
        id: created.id,
        anchor: created.anchor,
        status: "open",
        line: 7,
        excerpt: `Moved paragraph. ${created.anchor}`,
      }]);
    expect(events).toContainEqual({
      type: "annotations_changed",
      action: "moved",
      path: "renamed.md",
      previous_path: "paper.md",
      count: 1,
    });
  });

  it("reports local markers and open annotations in export preflight", async () => {
    const { dir, app } = workspace();
    const openRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Still open." }),
    });
    const openWithoutAnchorRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Anchor was not inserted." }),
    });
    const resolvedRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Already handled." }),
    });
    const open = (await json(openRes)).annotation as Record<string, string>;
    const openWithoutAnchor = (await json(openWithoutAnchorRes)).annotation as Record<string, string>;
    const resolved = (await json(resolvedRes)).annotation as Record<string, string>;
    await app.request(`/api/v1/repos/me/paper/local-annotations/${resolved.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ status: "resolved" }),
    });
    const source = [
      "# Paper",
      "",
      `Open ${open.anchor}`,
      `Resolved ${resolved.anchor}`,
      "Unknown [@local:la_aaaaaaaaaaaa]",
      "",
    ].join("\n");
    writeFileSync(join(dir, "paper.md"), source);

    const entry = { path: dir } as WorkspaceEntry;
    expect(localAnchorPreflightIssues(entry, "paper.md", source))
      .toEqual([
        {
          id: open.id,
          anchor: open.anchor,
          status: "open",
          line: 3,
          excerpt: `Open ${open.anchor}\nResolved ${resolved.anchor}`,
        },
        {
          id: resolved.id,
          anchor: resolved.anchor,
          status: "resolved",
          line: 4,
          excerpt: `Open ${open.anchor}\nResolved ${resolved.anchor}\nUnknown [@local:la_aaaaaaaaaaaa]`,
        },
        {
          id: "la_aaaaaaaaaaaa",
          anchor: "[@local:la_aaaaaaaaaaaa]",
          status: "missing",
          line: 5,
          excerpt: `Resolved ${resolved.anchor}\nUnknown [@local:la_aaaaaaaaaaaa]`,
        },
        {
          id: openWithoutAnchor.id,
          anchor: openWithoutAnchor.anchor,
          status: "open",
          line: null,
          excerpt: "",
        },
      ]);
  });

  it("blocks local PDF export while local annotation markers remain", async () => {
    const { app } = workspace();
    const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Finish before export." }),
    });
    const created = (await json(createdRes)).annotation as Record<string, string>;
    await app.request("/api/v1/repos/me/paper/file?path=paper.md&branch=main", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ content: `# Paper\n\nFinal paragraph. ${created.anchor}\n` }),
    });

    const res = await app.request("/me/paper/export/pdf/branch/main/paper.md");

    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("PDF export blocked by local annotations.");
    expect(body).toContain(created.anchor);
    expect(body).toContain("line 7");
  });

  it("blocks local PDF export when the annotation sidecar is corrupt", async () => {
    const { dir, app } = workspace();
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(join(dir, ".cosheaf", "local-annotations.json"), "{not json");

    const res = await app.request("/me/paper/export/pdf/branch/main/paper.md");

    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("PDF export blocked by local annotations.");
    expect(body).toContain("local annotations sidecar is not valid JSON");
  });

  it("reports open annotations whose anchor is missing from the source", async () => {
    const { dir, app } = workspace();
    const createdRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ path: "paper.md", body: "Anchor was not inserted." }),
    });
    const created = (await json(createdRes)).annotation as Record<string, string>;

    expect(localAnchorPreflightIssues({ path: dir } as WorkspaceEntry, "paper.md", "# Paper\n"))
      .toEqual([{
        id: created.id,
        anchor: created.anchor,
        status: "open",
        line: null,
        excerpt: "",
      }]);
  });
});
