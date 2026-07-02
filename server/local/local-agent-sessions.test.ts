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
import type { AppEnv, LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import type { WorkspaceEntry } from "./workspace-registry.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function workspace(): { dir: string; app: Hono<AppEnv>; entry: WorkspaceEntry } {
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
    }),
    entry,
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe("local Workbench agent sessions", () => {
  it("creates, lists, updates, and completes local agent sessions", async () => {
    const { dir, app } = workspace();
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

    const completeRes = await app.request("/api/v1/repos/me/paper/agent-sessions/as_aaaaaaaaaaaa/complete", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ summary: "Accepted.", message: "Done." }),
    });
    expect(completeRes.status).toBe(200);
    expect(((await json(completeRes)).session as Record<string, unknown>).status).toBe("done");
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
  });

  it("renders a waiting review diff and commits only accepted session files", async () => {
    const { dir, app } = workspace();
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

    const commitRes = await app.request("/me/paper/agent-sessions/as_bbbbbbbbbbbb/commit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" },
      body: new URLSearchParams({
        message: "Accept paper edit",
        accepted_file: "paper.md",
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
  });
});
