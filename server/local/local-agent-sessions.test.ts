import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { workspaceSlug } from "../../shared/conventions.js";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { createApp } from "../app.js";
import { buildLocalConfig } from "../db.js";
import { freshTestDb } from "../routes/test-fixtures.js";
import { type SSEEvent, SSEHub } from "../sse.js";
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import type { WorkspaceEntry } from "./workspace-registry.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function workspace(options: { sse?: SSEHub } = {}): { dir: string; app: Hono<AppEnv>; entry: WorkspaceEntry } {
  const dir = mkdtempSync(join(tmpdir(), "cosheaf-local-agent-sessions-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "Tester"]);
  writeFileSync(join(dir, "paper.md"), "# Paper\n\nFirst draft.\n");
  writeFileSync(join(dir, "appendix.md"), "# Appendix\n");
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
  const db = freshTestDb("local-agent-sessions-");
  const registry = new WorkspaceRegistry(db, { user: identity.user });
  const entry: WorkspaceEntry = {
    slug: workspaceSlug(identity.owner, identity.repo),
    path: dir,
    identity,
    backend: new LocalGitWorkspaceBackend(dir),
    remote: null,
    gitRemote: null,
  };
  registry.register(entry);
  return {
    dir,
    app: createApp({
      config: buildLocalConfig({ dataDir: join(dir, ".cosheaf"), port: 0 }),
      db,
      localRegistry: registry,
      sse: options.sse,
    }),
    entry,
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function reviewToken(page: string, path: string): string {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = page.match(new RegExp(`name="review_token" value="${escapedPath}\\t([0-9a-f]{64})"`));
  if (!match) throw new Error(`missing review token for ${path}`);
  return `${path}\t${match[1]}`;
}

describe("local Workbench agent sessions", () => {
  it("creates, lists, updates, and completes local agent sessions", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/paper", (event) => events.push(event));
    const { dir, app } = workspace({ sse });
    const createdRes = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        id: "as_aaaaaaaaaaaa",
        title: "Clarify intro",
        touched_files: ["paper.md"],
        linked_annotations: ["la_aaaaaaaaaaaa"],
        summary: "Initial run",
        message: "Started from the intro annotation.",
        author: "codex",
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await json(createdRes)).session as Record<string, unknown>;
    expect(created.status).toBe("active");
    expect(created.baseline_head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(created.touched_files).toEqual(["paper.md"]);

    const storedPath = join(dir, ".cosheaf", "agent-sessions.json");
    expect(existsSync(storedPath)).toBe(true);
    expect(JSON.parse(readFileSync(storedPath, "utf8")).sessions.as_aaaaaaaaaaaa).toBeTruthy();

    const listRes = await app.request("/api/v1/repos/me/paper/agent-sessions?status=active");
    expect(listRes.status).toBe(200);
    expect(((await json(listRes)).sessions as unknown[])).toHaveLength(1);

    const patchRes = await app.request("/api/v1/repos/me/paper/agent-sessions/as_aaaaaaaaaaaa", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        status: "waiting_for_review",
        touched_files: ["paper.md", "appendix.md"],
        message: "Ready for review.",
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await json(patchRes)).session as Record<string, unknown>;
    expect(patched.status).toBe("waiting_for_review");
    expect(patched.touched_files).toEqual(["paper.md", "appendix.md"]);
    expect(patched.messages).toHaveLength(2);

    try {
      const completeRes = await app.request("/api/v1/repos/me/paper/agent-sessions/as_aaaaaaaaaaaa/complete", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ summary: "Accepted.", message: "Done." }),
      });
      expect(completeRes.status).toBe(200);
      expect(((await json(completeRes)).session as Record<string, unknown>).status).toBe("done");
    } finally {
      unsubscribe();
    }
    expect(events).toEqual([
      {
        type: "agent_activity_changed",
        action: "created",
        id: "as_aaaaaaaaaaaa",
        status: "active",
        touched_files: ["paper.md"],
      },
      {
        type: "agent_activity_changed",
        action: "updated",
        id: "as_aaaaaaaaaaaa",
        status: "waiting_for_review",
        touched_files: ["paper.md", "appendix.md"],
      },
      {
        type: "agent_activity_changed",
        action: "completed",
        id: "as_aaaaaaaaaaaa",
        status: "done",
        touched_files: ["paper.md", "appendix.md"],
      },
    ]);
  });

  it("keeps the agent sessions sidecar out of git status", async () => {
    const { dir, app } = workspace();
    const res = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Local only", touched_files: ["paper.md"] }),
    });
    expect(res.status).toBe(201);
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("serializes concurrent agent session sidecar mutations", async () => {
    const { dir, app } = workspace();
    const ids = ["as_aaaaaaaaaaaa", "as_bbbbbbbbbbbb", "as_cccccccccccc", "as_dddddddddddd"];
    const responses = await Promise.all(ids.map((id) =>
      app.request("/api/v1/repos/me/paper/agent-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ id, title: `Session ${id}`, touched_files: ["paper.md"] }),
      }),
    ));
    expect(responses.map((res) => res.status)).toEqual([201, 201, 201, 201]);
    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "agent-sessions.json"), "utf8")) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(sidecar.sessions).sort()).toEqual(ids.sort());
  });

  it("refuses to overwrite a corrupt agent sessions sidecar", async () => {
    const { dir, app } = workspace();
    const storedPath = join(dir, ".cosheaf", "agent-sessions.json");
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(storedPath, "{not json");

    const createRes = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Do not erase", touched_files: ["paper.md"] }),
    });
    expect(createRes.status).toBe(409);
    expect(await json(createRes)).toEqual({
      error: "local agent sessions sidecar is invalid",
      details: "local agent sessions sidecar is not valid JSON",
    });
    expect(readFileSync(storedPath, "utf8")).toBe("{not json");

    const listRes = await app.request("/api/v1/repos/me/paper/agent-sessions");
    expect(listRes.status).toBe(409);
  });

  it("rejects unsafe touched file paths", async () => {
    const { app } = workspace();
    const res = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Bad path", touched_files: ["../paper.md"] }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "invalid touched_files" });

    const magic = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ title: "Bad pathspec", touched_files: [":(top)paper.md"] }),
    });
    expect(magic.status).toBe(400);
    expect(await json(magic)).toEqual({ error: "invalid touched_files" });
  });

  it("renders a waiting review diff and commits only accepted session files", async () => {
    const sse = new SSEHub();
    const events: SSEEvent[] = [];
    const unsubscribe = sse.subscribe("me/paper", (event) => events.push(event));
    const { dir, app } = workspace({ sse });
    const annotationRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ id: "la_aaaaaaaaaaaa", path: "paper.md", body: "Clarify intro." }),
    });
    expect(annotationRes.status).toBe(201);
    const sessionRes = await app.request("/api/v1/repos/me/paper/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({
        id: "as_bbbbbbbbbbbb",
        title: "Review edits",
        touched_files: ["paper.md", "appendix.md"],
        linked_annotations: ["la_aaaaaaaaaaaa"],
      }),
    });
    expect(sessionRes.status).toBe(201);
    writeFileSync(join(dir, "paper.md"), "# Paper\n\nImproved draft.\n");
    writeFileSync(join(dir, "appendix.md"), "# Appendix\n\nUnresolved note.\n");
    const waitRes = await app.request("/api/v1/repos/me/paper/agent-sessions/as_bbbbbbbbbbbb", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ status: "waiting_for_review" }),
    });
    expect(waitRes.status).toBe(200);

    const pageRes = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb");
    expect(pageRes.status).toBe(200);
    const page = await pageRes.text();
    expect(page).toContain("Improved draft.");
    expect(page).toContain("appendix.md");
    expect(page).toContain("data-testid=\"agent-session-commit-form\"");
    expect(page).toContain("la_aaaaaaaaaaaa");
    const stalePaperToken = reviewToken(page, "paper.md");

    const resolveRes = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb/annotations/la_aaaaaaaaaaaa", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ status: "resolved" }),
    });
    expect(resolveRes.status).toBe(303);
    const annotations = JSON.parse(readFileSync(join(dir, ".cosheaf", "local-annotations.json"), "utf8")) as {
      annotations: Record<string, { status: string }>;
    };
    expect(annotations.annotations.la_aaaaaaaaaaaa.status).toBe("resolved");
    expect(events).toContainEqual({ type: "annotations_changed", action: "updated", id: "la_aaaaaaaaaaaa", path: "paper.md" });

    const unrelatedRes = await app.request("/api/v1/repos/me/paper/local-annotations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ id: "la_cccccccccccc", path: "appendix.md", body: "Not part of this session." }),
    });
    expect(unrelatedRes.status).toBe(201);
    const unrelatedToggle = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb/annotations/la_cccccccccccc", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({ status: "resolved" }),
    });
    expect(unrelatedToggle.status).toBe(400);
    expect(await unrelatedToggle.text()).toContain("Annotation is not linked to this agent session.");

    writeFileSync(join(dir, "paper.md"), "# Paper\n\nChanged after review.\n");
    const staleCommitRes = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb/commit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({
        message: "Accept stale paper edit",
        accepted_file: "paper.md",
        review_token: stalePaperToken,
      }).toString(),
    });
    expect(staleCommitRes.status).toBe(400);
    expect(await staleCommitRes.text()).toContain("changed after this review page loaded");

    const refreshedPage = await (await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb")).text();

    const commitRes = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb/commit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({
        message: "Accept paper edit",
        accepted_file: "paper.md",
        review_token: reviewToken(refreshedPage, "paper.md"),
      }),
    });
    expect(commitRes.status).toBe(303);
    expect(git(dir, ["show", "--name-only", "--format=", "HEAD"]).trim()).toBe("paper.md");
    expect(git(dir, ["status", "--porcelain"])).toBe(" M appendix.md\n");

    const sidecar = JSON.parse(readFileSync(join(dir, ".cosheaf", "agent-sessions.json"), "utf8")) as {
      sessions: Record<string, { status: string; touched_files: string[] }>;
    };
    expect(sidecar.sessions.as_bbbbbbbbbbbb.status).toBe("waiting_for_review");
    expect(sidecar.sessions.as_bbbbbbbbbbbb.touched_files).toEqual(["appendix.md"]);
    expect(events).toContainEqual({ type: "git_changed", action: "committed", sha: expect.any(String), paths: ["paper.md"] });
    expect(events).toContainEqual({
      type: "agent_activity_changed",
      action: "committed",
      id: "as_bbbbbbbbbbbb",
      status: "waiting_for_review",
      touched_files: ["appendix.md"],
    });
    unsubscribe();
  });
});
