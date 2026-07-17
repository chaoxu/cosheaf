import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  LocalAgentSession,
  LocalAgentSessionMessage,
  LocalAgentSessionStatus,
} from "../../shared/local-agent-sessions.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { safeRel } from "../routes/files.js";
import { readJsonObject } from "../routes/query-params.js";
import {
  badRequestPage,
  htmlResponse,
  redirect,
  repoHref,
  stringField,
  type WebCtx,
  webRoute,
  webRouteForWrite,
} from "../routes/web-context.js";
import { emptyHtml, type Html, html } from "../routes/web-html.js";
import { repoPageShell } from "../routes/web-page.js";
import type { AppEnv } from "../types.js";
import { friendlyLine } from "./git-errors.js";
import { KeyedQueue } from "./keyed-queue.js";
import { localAnnotationSidecarConflict, readLocalAnnotations, setLocalAnnotationStatus } from "./local-annotations.js";
import { publishLocalAgentActivityEvent, publishLocalAnnotationEvent, publishLocalGitEvent } from "./local-events.js";
import type { LocalFileDiff } from "./local-git-backend.js";
import { localBackend, resolveLocalWorkspace } from "./local-mode.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

interface LocalAgentSessionFile {
  sessions: Record<string, LocalAgentSession>;
}

export class LocalAgentSessionSidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAgentSessionSidecarError";
  }
}

const LOCAL_AGENT_SESSIONS_FILE = join(".cosheaf", "agent-sessions.json");
const SESSION_ID_RE = /^as_[a-z0-9]{12}$/;
const MESSAGE_ID_RE = /^msg_[a-z0-9]{12}$/;
const LOCAL_ANNOTATION_ID_RE = /^la_[a-z0-9]{12}$/;
const mutationQueue = new KeyedQueue();

function newId(prefix: "as" | "msg"): string {
  return `${prefix}_${randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(12, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionFilePath(entry: WorkspaceEntry): string {
  return join(entry.path, LOCAL_AGENT_SESSIONS_FILE);
}

function normalizeStatus(value: unknown): LocalAgentSessionStatus | null {
  return value === "active" || value === "waiting_for_review" || value === "done" ? value : null;
}

function normalizeStringArray(value: unknown, normalize: (value: string) => string | null): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const normalized = normalize(item);
    if (!normalized) return null;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeTouchedFile(value: string): string | null {
  const rel = safeRel(value);
  if (!rel || rel.startsWith("-") || rel.startsWith(":")) return null;
  return rel;
}

function normalizeAnnotationId(value: string): string | null {
  return LOCAL_ANNOTATION_ID_RE.test(value) ? value : null;
}

function normalizeMessage(raw: unknown): LocalAgentSessionMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.id !== "string" || !MESSAGE_ID_RE.test(msg.id)) return null;
  if (typeof msg.author !== "string" || !msg.author.trim()) return null;
  if (typeof msg.created_at !== "string" || !msg.created_at.trim()) return null;
  if (typeof msg.body !== "string" || !msg.body.trim()) return null;
  return {
    id: msg.id,
    author: msg.author.trim(),
    created_at: msg.created_at,
    body: msg.body.trim(),
  };
}

function normalizeSession(raw: unknown): LocalAgentSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !SESSION_ID_RE.test(item.id)) return null;
  const status = normalizeStatus(item.status);
  if (!status) return null;
  if (typeof item.title !== "string" || !item.title.trim()) return null;
  if (typeof item.started_at !== "string" || !item.started_at.trim()) return null;
  if (typeof item.updated_at !== "string" || !item.updated_at.trim()) return null;
  if (item.baseline_head_sha !== null && typeof item.baseline_head_sha !== "string") return null;
  const touchedFiles = normalizeStringArray(item.touched_files, normalizeTouchedFile);
  const linkedAnnotations = normalizeStringArray(item.linked_annotations, normalizeAnnotationId);
  if (!touchedFiles || !linkedAnnotations) return null;
  if (typeof item.summary !== "string") return null;
  if (!Array.isArray(item.messages)) return null;
  const messages: LocalAgentSessionMessage[] = [];
  for (const message of item.messages) {
    const normalized = normalizeMessage(message);
    if (!normalized) return null;
    messages.push(normalized);
  }
  return {
    id: item.id,
    status,
    title: item.title.trim(),
    started_at: item.started_at,
    updated_at: item.updated_at,
    baseline_head_sha: item.baseline_head_sha,
    touched_files: touchedFiles,
    linked_annotations: linkedAnnotations,
    summary: item.summary.trim(),
    messages,
  };
}

export function readLocalAgentSessions(entry: WorkspaceEntry): LocalAgentSessionFile {
  const file = sessionFilePath(entry);
  if (!existsSync(file)) return { sessions: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (_err) {
    throw new LocalAgentSessionSidecarError("local agent sessions sidecar is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new LocalAgentSessionSidecarError("local agent sessions sidecar must be an object");
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions))
    throw new LocalAgentSessionSidecarError("local agent sessions sidecar must contain a sessions object");
  const normalized: Record<string, LocalAgentSession> = {};
  for (const [key, value] of Object.entries(sessions)) {
    const item = normalizeSession(value);
    if (!item || item.id !== key)
      throw new LocalAgentSessionSidecarError(`local agent sessions sidecar contains an invalid session: ${key}`);
    normalized[item.id] = item;
  }
  return { sessions: normalized };
}

export function writeLocalAgentSessions(entry: WorkspaceEntry, data: LocalAgentSessionFile): void {
  const file = sessionFilePath(entry);
  mkdirSync(join(entry.path, ".cosheaf"), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

async function withLocalAgentSessionMutation<T>(entry: WorkspaceEntry, fn: () => Promise<T> | T): Promise<T> {
  return mutationQueue.run(entry.slug, fn);
}

export function localAgentSessionSidecarConflict(err: unknown): { error: string; details: string } | null {
  if (!(err instanceof LocalAgentSessionSidecarError)) return null;
  return {
    error: "local agent sessions sidecar is invalid",
    details: err.message,
  };
}

export function sortedLocalAgentSessions(data: LocalAgentSessionFile): LocalAgentSession[] {
  return Object.values(data.sessions).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
}

function localAgentSessionEntry(c: import("hono").Context<AppEnv>): WorkspaceEntry | null {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo) return null;
  return resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry ?? null;
}

function applySessionPatch(session: LocalAgentSession, body: Record<string, unknown>, updatedAt: string): string | null {
  if (body.status !== undefined) {
    const status = normalizeStatus(body.status);
    if (!status) return "invalid status";
    session.status = status;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) return "title required";
    session.title = body.title.trim();
  }
  if (body.summary !== undefined) {
    if (typeof body.summary !== "string") return "invalid summary";
    session.summary = body.summary.trim();
  }
  if (body.touched_files !== undefined) {
    const touchedFiles = normalizeStringArray(body.touched_files, normalizeTouchedFile);
    if (!touchedFiles) return "invalid touched_files";
    session.touched_files = touchedFiles;
  }
  if (body.linked_annotations !== undefined) {
    const linkedAnnotations = normalizeStringArray(body.linked_annotations, normalizeAnnotationId);
    if (!linkedAnnotations) return "invalid linked_annotations";
    session.linked_annotations = linkedAnnotations;
  }
  session.updated_at = updatedAt;
  return null;
}

function appendMessage(session: LocalAgentSession, body: Record<string, unknown>, author: string, createdAt: string): string | null {
  if (body.message === undefined) return null;
  if (typeof body.message !== "string" || !body.message.trim()) return "message required";
  session.messages.push({
    id: newId("msg"),
    author,
    created_at: createdAt,
    body: body.message.trim(),
  });
  return null;
}

export const localAgentSessions = new Hono<AppEnv>();
localAgentSessions.use("*", requireAuth);
localAgentSessions.use("/:owner/:repo/*", requireMembership());
localAgentSessions.use("/:owner/:repo/*", requireWriteOnMutation);

localAgentSessions.get("/:owner/:repo/agent-sessions", (c) => {
  const entry = localAgentSessionEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const status = c.req.query("status");
  if (status !== undefined && !normalizeStatus(status)) return c.json({ error: "invalid status" }, 400);
  try {
    const sessions = sortedLocalAgentSessions(readLocalAgentSessions(entry))
      .filter((session) => (status ? session.status === status : true));
    return c.json({ sessions });
  } catch (err) {
    const conflict = localAgentSessionSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

localAgentSessions.get("/:owner/:repo/agent-sessions/:id", (c) => {
  const entry = localAgentSessionEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid session id" }, 400);
  try {
    const session = readLocalAgentSessions(entry).sessions[id];
    if (!session) return c.json({ error: "session not found" }, 404);
    return c.json({ session });
  } catch (err) {
    const conflict = localAgentSessionSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

localAgentSessions.post("/:owner/:repo/agent-sessions", async (c) => {
  const entry = localAgentSessionEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const body = await readJsonObject(c.req);
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Agent session";
  const touchedFiles = body.touched_files === undefined ? [] : normalizeStringArray(body.touched_files, normalizeTouchedFile);
  const linkedAnnotations = body.linked_annotations === undefined ? [] : normalizeStringArray(body.linked_annotations, normalizeAnnotationId);
  if (!touchedFiles) return c.json({ error: "invalid touched_files" }, 400);
  if (!linkedAnnotations) return c.json({ error: "invalid linked_annotations" }, 400);
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";
  const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : c.get("user").username;
  return await withLocalAgentSessionMutation(entry, async () => {
    let data: LocalAgentSessionFile;
    try {
      data = readLocalAgentSessions(entry);
    } catch (err) {
      const conflict = localAgentSessionSidecarConflict(err);
      if (conflict) return c.json(conflict, 409);
      throw err;
    }
    const id = typeof body.id === "string" && SESSION_ID_RE.test(body.id) ? body.id : newId("as");
    if (data.sessions[id]) return c.json({ error: "session already exists" }, 409);
    const created = nowIso();
    const session: LocalAgentSession = {
      id,
      status: "active",
      title,
      started_at: created,
      updated_at: created,
      baseline_head_sha: await entry.backend.currentHeadSha(),
      touched_files: touchedFiles,
      linked_annotations: linkedAnnotations,
      summary,
      messages: [],
    };
    const messageError = appendMessage(session, body, author, created);
    if (messageError) return c.json({ error: messageError }, 400);
    data.sessions[id] = session;
    writeLocalAgentSessions(entry, data);
    publishLocalAgentActivityEvent(c, entry, {
      action: "created",
      id: session.id,
      status: session.status,
      touched_files: session.touched_files,
    });
    return c.json({ session }, 201);
  });
});

localAgentSessions.patch("/:owner/:repo/agent-sessions/:id", async (c) => {
  const entry = localAgentSessionEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid session id" }, 400);
  const body = await readJsonObject(c.req);
  return await withLocalAgentSessionMutation(entry, () => {
    let data: LocalAgentSessionFile;
    try {
      data = readLocalAgentSessions(entry);
    } catch (err) {
      const conflict = localAgentSessionSidecarConflict(err);
      if (conflict) return c.json(conflict, 409);
      throw err;
    }
    const session = data.sessions[id];
    if (!session) return c.json({ error: "session not found" }, 404);
    const updated = nowIso();
    const patchError = applySessionPatch(session, body, updated);
    if (patchError) return c.json({ error: patchError }, 400);
    const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : c.get("user").username;
    const messageError = appendMessage(session, body, author, updated);
    if (messageError) return c.json({ error: messageError }, 400);
    writeLocalAgentSessions(entry, data);
    publishLocalAgentActivityEvent(c, entry, {
      action: "updated",
      id: session.id,
      status: session.status,
      touched_files: session.touched_files,
    });
    return c.json({ session });
  });
});

localAgentSessions.post("/:owner/:repo/agent-sessions/:id/complete", async (c) => {
  const entry = localAgentSessionEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid session id" }, 400);
  const body = await readJsonObject(c.req);
  return await withLocalAgentSessionMutation(entry, () => {
    let data: LocalAgentSessionFile;
    try {
      data = readLocalAgentSessions(entry);
    } catch (err) {
      const conflict = localAgentSessionSidecarConflict(err);
      if (conflict) return c.json(conflict, 409);
      throw err;
    }
    const session = data.sessions[id];
    if (!session) return c.json({ error: "session not found" }, 404);
    const updated = nowIso();
    if (body.summary !== undefined) {
      if (typeof body.summary !== "string") return c.json({ error: "invalid summary" }, 400);
      session.summary = body.summary.trim();
    }
    const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : c.get("user").username;
    const messageError = appendMessage(session, body, author, updated);
    if (messageError) return c.json({ error: messageError }, 400);
    session.status = "done";
    session.updated_at = updated;
    writeLocalAgentSessions(entry, data);
    publishLocalAgentActivityEvent(c, entry, {
      action: "completed",
      id: session.id,
      status: session.status,
      touched_files: session.touched_files,
    });
    return c.json({ session });
  });
});

function statusLabel(status: LocalAgentSessionStatus): string {
  if (status === "waiting_for_review") return "waiting for review";
  return status;
}

function sessionHref(ctx: WebCtx, session: LocalAgentSession): string {
  return repoHref(ctx.owner, ctx.repo, `/agent-sessions/${encodeURIComponent(session.id)}`);
}

function sessionCard(ctx: WebCtx, session: LocalAgentSession): Html {
  return html`<li class="agent-session-card agent-session-card--${session.status}" data-testid="agent-session-card">
    <div>
      <a href="${sessionHref(ctx, session)}"><strong>${session.title}</strong></a>
      <p class="muted">${statusLabel(session.status)} · ${session.touched_files.length} touched file${session.touched_files.length === 1 ? "" : "s"} · updated ${session.updated_at}</p>
      ${session.summary ? html`<p>${session.summary}</p>` : emptyHtml}
    </div>
  </li>`;
}

function agentSessionsListPage(ctx: WebCtx, sessions: LocalAgentSession[], notice: string | null): string {
  const waiting = sessions.filter((session) => session.status === "waiting_for_review");
  const others = sessions.filter((session) => session.status !== "waiting_for_review");
  const body = html`
    <div class="page-title compact"><div><h1>Agent sessions</h1></div></div>
    ${notice ? html`<p class="muted" data-testid="agent-session-notice">${notice}</p>` : emptyHtml}
    <p class="muted">Local drafting sessions for this folder. They are stored in the gitignored Workbench sidecar, not on the Cosheaf server.</p>
    ${
      sessions.length === 0
        ? html`<div class="empty" data-testid="agent-sessions-empty">No local agent sessions yet.</div>`
        : html`
          ${waiting.length > 0 ? html`<h2>Waiting for review</h2><ul class="agent-session-list">${waiting.map((session) => sessionCard(ctx, session))}</ul>` : emptyHtml}
          ${others.length > 0 ? html`<h2>Recent</h2><ul class="agent-session-list">${others.map((session) => sessionCard(ctx, session))}</ul>` : emptyHtml}
        `
    }
  `;
  return repoPageShell(ctx, "agents", `Agent sessions - ${ctx.repo}`, body);
}

function annotationRows(entry: WorkspaceEntry, ctx: WebCtx, session: LocalAgentSession): Html {
  if (session.linked_annotations.length === 0) return html`<p class="muted">No linked local annotations.</p>`;
  let annotations: ReturnType<typeof readLocalAnnotations>["annotations"];
  try {
    annotations = readLocalAnnotations(entry).annotations;
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    return html`<p class="muted">${conflict ? conflict.details : "Could not read linked annotations."}</p>`;
  }
  return html`<ul class="agent-session-annotations" data-testid="agent-session-annotations">
    ${session.linked_annotations.map((id) => {
      const annotation = annotations[id];
      const status = annotation?.status ?? "missing";
      const targetStatus = status === "open" ? "resolved" : "open";
      return html`<li>
        <code>${id}</code>
        <span class="badge">${status}</span>
        ${annotation ? html`<span class="muted">${annotation.path}</span>` : emptyHtml}
        ${annotation
          ? html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/agent-sessions/${session.id}/annotations/${id}`)}">
              <input type="hidden" name="status" value="${targetStatus}">
              <button class="button subtle" type="submit">${targetStatus === "resolved" ? "Resolve" : "Reopen"}</button>
            </form>`
          : emptyHtml}
      </li>`;
    })}
  </ul>`;
}

function fileDiffBlock(diff: LocalFileDiff): Html {
  return html`<details class="agent-session-diff" data-testid="agent-session-diff" open>
    <summary>
      <label>
        <input type="checkbox" name="accepted_file" value="${diff.path}" ${diff.changed ? "checked" : ""} ${diff.changed ? "" : "disabled"}>
        <input type="hidden" name="review_token" value="${diff.path}	${diff.review_hash}">
        <code>${diff.path}</code>
      </label>
      ${diff.changed ? html`<span class="badge">changed</span>` : html`<span class="badge">clean</span>`}
    </summary>
    ${diff.patch ? html`<pre>${diff.patch}</pre>` : html`<p class="muted">No uncommitted changes for this file.</p>`}
  </details>`;
}

async function agentSessionReviewPage(
  entry: WorkspaceEntry,
  ctx: WebCtx,
  session: LocalAgentSession,
  notice: string | null,
): Promise<string> {
  const diffs = await localBackend(ctx).diffForPaths(session.baseline_head_sha, session.touched_files);
  const changed = diffs.filter((diff) => diff.changed);
  const body = html`
    <div class="page-title compact">
      <div>
        <h1>${session.title}</h1>
        <p class="muted">${statusLabel(session.status)} · started ${session.started_at}</p>
      </div>
    </div>
    ${notice ? html`<p class="muted" data-testid="agent-session-notice">${notice}</p>` : emptyHtml}
    ${session.summary ? html`<p>${session.summary}</p>` : emptyHtml}
    <section class="agent-session-section">
      <h2>Linked annotations</h2>
      ${annotationRows(entry, ctx, session)}
    </section>
    <section class="agent-session-section">
      <h2>Changed files</h2>
      ${
        session.touched_files.length === 0
          ? html`<div class="empty">This session has no touched files.</div>`
          : html`<form method="post" action="${repoHref(ctx.owner, ctx.repo, `/agent-sessions/${session.id}/commit`)}" data-testid="agent-session-commit-form">
              <div class="agent-session-diffs">${diffs.map(fileDiffBlock)}</div>
              ${
                changed.length > 0
                  ? html`<label>Commit message
                      <input name="message" required value="Accept agent session: ${session.title}">
                    </label>
                    <div class="form-actions">
                      <button class="button primary" type="submit">Commit selected files</button>
                      <a class="button subtle" href="${repoHref(ctx.owner, ctx.repo, "/commit")}">Open commit page</a>
                    </div>`
                  : html`<div class="empty" data-testid="agent-session-clean">No uncommitted changes in touched files.</div>`
              }
            </form>`
      }
    </section>
  `;
  return repoPageShell(ctx, "agents", `${session.title} - ${ctx.repo}`, body);
}

function selectedFiles(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string") continue;
    const path = safeRel(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function reviewTokens(value: unknown): Map<string, string> {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out = new Map<string, string>();
  for (const item of values) {
    if (typeof item !== "string") continue;
    const sep = item.indexOf("\t");
    if (sep < 0) continue;
    const path = safeRel(item.slice(0, sep));
    const hash = item.slice(sep + 1);
    if (!path || !/^[0-9a-f]{64}$/.test(hash)) continue;
    out.set(path, hash);
  }
  return out;
}

function getSessionForWeb(entry: WorkspaceEntry, id: string): LocalAgentSession | null {
  if (!SESSION_ID_RE.test(id)) return null;
  return readLocalAgentSessions(entry).sessions[id] ?? null;
}

export function registerLocalAgentSessionRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/agent-sessions", webRoute((c, ctx) => {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
    try {
      return htmlResponse(agentSessionsListPage(ctx, sortedLocalAgentSessions(readLocalAgentSessions(entry)), c.req.query("toast") ?? null));
    } catch (err) {
      const conflict = localAgentSessionSidecarConflict(err);
      if (conflict) return badRequestPage(ctx.user, conflict.details);
      throw err;
    }
  }));

  web.get("/:owner/:repo/agent-sessions/:id", webRoute(async (c, ctx) => {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
    try {
      const session = getSessionForWeb(entry, c.req.param("id") ?? "");
      if (!session) return badRequestPage(ctx.user, "Agent session not found.");
      return htmlResponse(await agentSessionReviewPage(entry, ctx, session, c.req.query("toast") ?? null));
    } catch (err) {
      const conflict = localAgentSessionSidecarConflict(err);
      if (conflict) return badRequestPage(ctx.user, conflict.details);
      throw err;
    }
  }));

  web.post("/:owner/:repo/agent-sessions/:id/annotations/:annotationId", webRouteForWrite(async (c, ctx) => {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
    const sessionId = c.req.param("id") ?? "";
    const annotationId = c.req.param("annotationId") ?? "";
    const form = await c.req.parseBody();
    const status = stringField(form.status);
    if (status !== "open" && status !== "resolved") return badRequestPage(ctx.user, "Invalid annotation status.");
    try {
      const session = getSessionForWeb(entry, sessionId);
      if (!session) return badRequestPage(ctx.user, "Agent session not found.");
      if (!session.linked_annotations.includes(annotationId))
        return badRequestPage(ctx.user, "Annotation is not linked to this agent session.");
      const annotation = setLocalAnnotationStatus(entry, annotationId, status);
      if (!annotation) return badRequestPage(ctx.user, "Annotation not found.");
      publishLocalAnnotationEvent(c, entry, { action: "updated", id: annotationId, path: annotation.path });
    } catch (err) {
      const conflict = localAnnotationSidecarConflict(err);
      if (conflict) return badRequestPage(ctx.user, conflict.details);
      throw err;
    }
    return redirect(`${repoHref(ctx.owner, ctx.repo, `/agent-sessions/${sessionId}`)}?toast=${encodeURIComponent("Annotation updated.")}`);
  }));

  web.post("/:owner/:repo/agent-sessions/:id/commit", webRouteForWrite(async (c, ctx) => {
    const entry = resolveLocalWorkspace(c.get("localRegistry"), ctx.owner, ctx.repo)?.entry;
    if (!entry) return badRequestPage(ctx.user, "Workspace not found.");
    const sessionId = c.req.param("id") ?? "";
    const form = await c.req.parseBody();
    const message = stringField(form.message);
    if (!message) return badRequestPage(ctx.user, "A commit message is required.");
    const acceptedFiles = selectedFiles(form.accepted_file);
    const tokens = reviewTokens(form.review_token);
    if (acceptedFiles.length === 0) return badRequestPage(ctx.user, "Select at least one changed file.");
    return await withLocalAgentSessionMutation(entry, async () => {
      let data: LocalAgentSessionFile;
      try {
        data = readLocalAgentSessions(entry);
      } catch (err) {
        const conflict = localAgentSessionSidecarConflict(err);
        if (conflict) return badRequestPage(ctx.user, conflict.details);
        throw err;
      }
      const session = data.sessions[sessionId];
      if (!session) return badRequestPage(ctx.user, "Agent session not found.");
      const allowed = new Set(session.touched_files);
      const commitFiles = acceptedFiles.filter((path) => allowed.has(path));
      if (commitFiles.length === 0) return badRequestPage(ctx.user, "Selected files are not part of this session.");
      const currentDiffs = await localBackend(ctx).diffForPaths(session.baseline_head_sha, commitFiles);
      for (const diff of currentDiffs) {
        if (tokens.get(diff.path) !== diff.review_hash) {
          return badRequestPage(ctx.user, "A selected file changed after this review page loaded. Reload the agent session and review the latest diff before committing.");
        }
      }
      let sha: string | null;
      try {
        sha = await localBackend(ctx).commitPaths(message, commitFiles);
      } catch (err) {
        return badRequestPage(ctx.user, friendlyLine(err));
      }
      if (!sha) return redirect(`${repoHref(ctx.owner, ctx.repo, `/agent-sessions/${sessionId}`)}?toast=${encodeURIComponent("Nothing to commit.")}`);
      const remainingDiffs = await localBackend(ctx).diffForPaths(sha, session.touched_files);
      const remaining = remainingDiffs.filter((diff) => diff.changed).map((diff) => diff.path);
      const updated = nowIso();
      session.baseline_head_sha = sha;
      session.touched_files = remaining;
      session.status = remaining.length === 0 ? "done" : "waiting_for_review";
      session.updated_at = updated;
      session.messages.push({
        id: newId("msg"),
        author: ctx.user,
        created_at: updated,
        body: `Committed ${sha.slice(0, 8)} from review.`,
      });
      data.sessions[session.id] = session;
      writeLocalAgentSessions(entry, data);
      publishLocalGitEvent(c, entry, { action: "committed", sha, paths: commitFiles });
      publishLocalAgentActivityEvent(c, entry, {
        action: "committed",
        id: session.id,
        status: session.status,
        touched_files: session.touched_files,
      });
      return redirect(`${repoHref(ctx.owner, ctx.repo, `/agent-sessions/${sessionId}`)}?toast=${encodeURIComponent(`Committed ${sha.slice(0, 8)}`)}`);
    });
  }));
}
