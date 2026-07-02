import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  LocalAnnotation,
  LocalAnnotationContext,
  LocalAnnotationKind,
  LocalAnnotationMessage,
  LocalAnnotationQueueItem,
  LocalAnnotationStatus,
} from "../../shared/local-annotations.js";
import { readJsonObject } from "../routes/query-params.js";
import { safeRel } from "../routes/files.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { publishLocalAnnotationEvent } from "./local-events.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

export interface LocalAnchorPreflightIssue {
  id: string;
  anchor: string;
  status: "open" | "resolved" | "missing";
  line: number | null;
  excerpt: string;
}

interface LocalAnnotationFile {
  annotations: Record<string, LocalAnnotation>;
}

export class LocalAnnotationSidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAnnotationSidecarError";
  }
}

const LOCAL_ANNOTATIONS_FILE = join(".cosheaf", "local-annotations.json");
const ANNOTATION_ID_RE = /^la_[a-z0-9]{12}$/;
const MESSAGE_ID_RE = /^msg_[a-z0-9]{12}$/;
const LOCAL_ANCHOR_RE = /\[@local:(la_[a-z0-9]{12})\]/g;

function newId(prefix: "la" | "msg"): string {
  return `${prefix}_${randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(12, "0")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function annotationFilePath(entry: WorkspaceEntry): string {
  return join(entry.path, LOCAL_ANNOTATIONS_FILE);
}

function readWorkspaceText(entry: WorkspaceEntry, rel: string): string | null {
  try {
    return readFileSync(join(entry.path, rel), "utf8");
  } catch (_err) {
    return null;
  }
}

function normalizeKind(value: unknown): LocalAnnotationKind | null {
  return value === "comment" || value === "task" ? value : null;
}

function normalizeStatus(value: unknown): LocalAnnotationStatus | null {
  return value === "open" || value === "resolved" ? value : null;
}

function normalizeMessage(raw: unknown): LocalAnnotationMessage | null {
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
    body: msg.body,
  };
}

function normalizeAnnotation(raw: unknown): LocalAnnotation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !ANNOTATION_ID_RE.test(item.id)) return null;
  const kind = normalizeKind(item.kind);
  const status = normalizeStatus(item.status);
  const path = typeof item.path === "string" ? safeRel(item.path) : null;
  const anchor = typeof item.anchor === "string" && item.anchor === `[@local:${item.id}]` ? item.anchor : null;
  if (!kind || !status || !path || !anchor) return null;
  if (typeof item.created_at !== "string" || typeof item.updated_at !== "string") return null;
  if (!Array.isArray(item.messages)) return null;
  const messages: LocalAnnotationMessage[] = [];
  for (const message of item.messages) {
    const normalized = normalizeMessage(message);
    if (!normalized) return null;
    messages.push(normalized);
  }
  return {
    id: item.id,
    kind,
    status,
    path,
    anchor,
    created_at: item.created_at,
    updated_at: item.updated_at,
    messages,
  };
}

export function readLocalAnnotations(entry: WorkspaceEntry): LocalAnnotationFile {
  const file = annotationFilePath(entry);
  if (!existsSync(file)) return { annotations: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (_err) {
    throw new LocalAnnotationSidecarError("local annotations sidecar is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new LocalAnnotationSidecarError("local annotations sidecar must be an object");
  const annotations = (raw as { annotations?: unknown }).annotations;
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations))
    throw new LocalAnnotationSidecarError("local annotations sidecar must contain an annotations object");
  const normalized: Record<string, LocalAnnotation> = {};
  for (const [key, value] of Object.entries(annotations)) {
    const item = normalizeAnnotation(value);
    if (!item || item.id !== key)
      throw new LocalAnnotationSidecarError(`local annotations sidecar contains an invalid annotation: ${key}`);
    normalized[item.id] = item;
  }
  return { annotations: normalized };
}

export function writeLocalAnnotations(entry: WorkspaceEntry, data: LocalAnnotationFile): void {
  const file = annotationFilePath(entry);
  mkdirSync(join(entry.path, ".cosheaf"), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

export function moveLocalAnnotationsPath(entry: WorkspaceEntry, fromPath: string, toPath: string): number {
  const from = safeRel(fromPath);
  const to = safeRel(toPath);
  if (!from || !to || from === to) return 0;
  const data = readLocalAnnotations(entry);
  const updatedAt = nowIso();
  let moved = 0;
  for (const annotation of Object.values(data.annotations)) {
    if (annotation.path !== from) continue;
    data.annotations[annotation.id] = { ...annotation, path: to, updated_at: updatedAt };
    moved += 1;
  }
  if (moved > 0) writeLocalAnnotations(entry, data);
  return moved;
}

export function assertLocalAnnotationsReadable(entry: WorkspaceEntry): void {
  readLocalAnnotations(entry);
}

export function localAnnotationSidecarConflict(err: unknown): { error: string; details: string } | null {
  if (!(err instanceof LocalAnnotationSidecarError)) return null;
  return {
    error: "local annotations sidecar is invalid",
    details: err.message,
  };
}

function localAnnotationEntry(c: import("hono").Context<AppEnv>): WorkspaceEntry | null {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo) return null;
  return resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry ?? null;
}

function sortedAnnotations(data: LocalAnnotationFile): LocalAnnotation[] {
  return Object.values(data.annotations).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function sourceContext(source: string | null, anchor: string): LocalAnnotationContext {
  if (source === null) return { line: null, excerpt: "", anchor_found: false };
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index < 0) return { line: null, excerpt: "", anchor_found: false };
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return {
    line: index + 1,
    excerpt: lines.slice(start, end).join("\n").trim(),
    anchor_found: true,
  };
}

export function localAnnotationQueue(entry: WorkspaceEntry, opts: { path?: string | null } = {}): LocalAnnotationQueueItem[] {
  const path = opts.path ? safeRel(opts.path) : null;
  const data = readLocalAnnotations(entry);
  const sourceByPath = new Map<string, string | null>();
  return sortedAnnotations(data)
    .filter((annotation) => annotation.status === "open")
    .filter((annotation) => !path || annotation.path === path)
    .map((annotation) => {
      if (!sourceByPath.has(annotation.path)) sourceByPath.set(annotation.path, readWorkspaceText(entry, annotation.path));
      return {
        ...annotation,
        context: sourceContext(sourceByPath.get(annotation.path) ?? null, annotation.anchor),
      };
    });
}

export function localAnchorPreflightIssues(entry: WorkspaceEntry, path: string, source: string): LocalAnchorPreflightIssue[] {
  const rel = safeRel(path);
  if (!rel) return [];
  const data = readLocalAnnotations(entry);
  const issues: LocalAnchorPreflightIssue[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(LOCAL_ANCHOR_RE)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const anchor = `[@local:${id}]`;
    const annotation = data.annotations[id];
    const context = sourceContext(source, anchor);
    issues.push({
      id,
      anchor,
      status: annotation?.path === rel ? annotation.status : "missing",
      line: context.line,
      excerpt: context.excerpt,
    });
  }
  for (const annotation of sortedAnnotations(data)) {
    if (annotation.path !== rel || annotation.status !== "open" || seen.has(annotation.id)) continue;
    issues.push({
      id: annotation.id,
      anchor: annotation.anchor,
      status: "open",
      line: null,
      excerpt: "",
    });
  }
  return issues;
}

export function setLocalAnnotationStatus(entry: WorkspaceEntry, id: string, status: LocalAnnotationStatus): LocalAnnotation | null {
  if (!ANNOTATION_ID_RE.test(id)) return null;
  const data = readLocalAnnotations(entry);
  const annotation = data.annotations[id];
  if (!annotation) return null;
  annotation.status = status;
  annotation.updated_at = nowIso();
  writeLocalAnnotations(entry, data);
  return annotation;
}

export const localAnnotations = new Hono<AppEnv>();
localAnnotations.use("*", requireAuth);
localAnnotations.use("/:owner/:repo/*", requireMembership());
localAnnotations.use("/:owner/:repo/*", requireWriteOnMutation);

localAnnotations.get("/:owner/:repo/local-annotations/unresolved", (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const path = c.req.query("path");
  const rel = path ? safeRel(path) : null;
  if (path && !rel) return c.json({ error: "invalid path" }, 400);
  try {
    return c.json({ annotations: localAnnotationQueue(entry, { path: rel }) });
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
});

localAnnotations.get("/:owner/:repo/local-annotations", (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const status = c.req.query("status");
  const rawPath = c.req.query("path");
  const path = rawPath ? safeRel(rawPath) : null;
  if (rawPath && !path) return c.json({ error: "invalid path" }, 400);
  let all: LocalAnnotation[];
  try {
    all = sortedAnnotations(readLocalAnnotations(entry));
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
  const filtered = all.filter((item) =>
    (status === "open" || status === "resolved" ? item.status === status : true) &&
    (path ? item.path === path : true),
  );
  return c.json({ annotations: filtered });
});

localAnnotations.post("/:owner/:repo/local-annotations", async (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const body = await readJsonObject(c.req);
  const kind = normalizeKind(body.kind) ?? "comment";
  const path = typeof body.path === "string" ? safeRel(body.path) : null;
  const message = typeof body.body === "string" ? body.body.trim() : "";
  const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : c.get("user").username;
  if (!path) return c.json({ error: "path required" }, 400);
  if (!message) return c.json({ error: "body required" }, 400);

  let data: LocalAnnotationFile;
  try {
    data = readLocalAnnotations(entry);
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
  const id = typeof body.id === "string" && ANNOTATION_ID_RE.test(body.id) ? body.id : newId("la");
  if (data.annotations[id]) return c.json({ error: "annotation already exists" }, 409);
  const created = nowIso();
  const annotation: LocalAnnotation = {
    id,
    kind,
    status: "open",
    path,
    anchor: `[@local:${id}]`,
    created_at: created,
    updated_at: created,
    messages: [{
      id: newId("msg"),
      author,
      created_at: created,
      body: message,
    }],
  };
  data.annotations[id] = annotation;
  writeLocalAnnotations(entry, data);
  publishLocalAnnotationEvent(c, entry, { action: "created", id: annotation.id, path: annotation.path });
  return c.json({ annotation }, 201);
});

localAnnotations.patch("/:owner/:repo/local-annotations/:id", async (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!ANNOTATION_ID_RE.test(id)) return c.json({ error: "invalid annotation id" }, 400);
  const body = await readJsonObject(c.req);
  let data: LocalAnnotationFile;
  try {
    data = readLocalAnnotations(entry);
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
  const annotation = data.annotations[id];
  if (!annotation) return c.json({ error: "annotation not found" }, 404);
  const previousPath = annotation.path;
  const status = body.status === undefined ? null : normalizeStatus(body.status);
  if (body.status !== undefined && !status) return c.json({ error: "invalid status" }, 400);
  if (status) annotation.status = status;
  if (typeof body.path === "string") {
    const path = safeRel(body.path);
    if (!path) return c.json({ error: "invalid path" }, 400);
    annotation.path = path;
  }
  annotation.updated_at = nowIso();
  writeLocalAnnotations(entry, data);
  publishLocalAnnotationEvent(c, entry, {
    action: "updated",
    id: annotation.id,
    path: annotation.path,
    ...(previousPath !== annotation.path ? { previous_path: previousPath } : {}),
  });
  return c.json({ annotation });
});

localAnnotations.post("/:owner/:repo/local-annotations/:id/messages", async (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!ANNOTATION_ID_RE.test(id)) return c.json({ error: "invalid annotation id" }, 400);
  const body = await readJsonObject(c.req);
  const message = typeof body.body === "string" ? body.body.trim() : "";
  const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : c.get("user").username;
  if (!message) return c.json({ error: "body required" }, 400);
  let data: LocalAnnotationFile;
  try {
    data = readLocalAnnotations(entry);
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
  const annotation = data.annotations[id];
  if (!annotation) return c.json({ error: "annotation not found" }, 404);
  const created = nowIso();
  annotation.messages.push({
    id: newId("msg"),
    author,
    created_at: created,
    body: message,
  });
  annotation.updated_at = created;
  writeLocalAnnotations(entry, data);
  publishLocalAnnotationEvent(c, entry, { action: "message", id: annotation.id, path: annotation.path });
  return c.json({ annotation });
});

localAnnotations.delete("/:owner/:repo/local-annotations/:id", (c) => {
  const entry = localAnnotationEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const id = c.req.param("id");
  if (!ANNOTATION_ID_RE.test(id)) return c.json({ error: "invalid annotation id" }, 400);
  let data: LocalAnnotationFile;
  try {
    data = readLocalAnnotations(entry);
  } catch (err) {
    const conflict = localAnnotationSidecarConflict(err);
    if (conflict) return c.json(conflict, 409);
    throw err;
  }
  if (!data.annotations[id]) return c.json({ error: "annotation not found" }, 404);
  const annotation = data.annotations[id];
  delete data.annotations[id];
  writeLocalAnnotations(entry, data);
  publishLocalAnnotationEvent(c, entry, { action: "deleted", id: annotation.id, path: annotation.path });
  return c.json({ ok: true });
});
