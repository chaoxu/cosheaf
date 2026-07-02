import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { fileKindForPath } from "../../shared/file-kind.js";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { safeRel } from "../routes/files.js";
import { bad, notFound } from "../routes/responses.js";
import { resolveLocalWorkspace } from "./local-mode.js";

const SIDECAR_PATH = join(".cosheaf", "local-annotations.json");
const LOCAL_ANCHOR_RE = /\[@local:([A-Za-z0-9_.:-]+)\]/g;

export interface LocalAnnotationMessage {
  author?: string;
  timestamp?: string;
  text: string;
}

export interface LocalAnnotationRecord {
  id: string;
  path: string;
  kind: "comment" | "task";
  status: "open" | "resolved";
  messages: LocalAnnotationMessage[];
}

interface LocalAnnotationQueueItem extends LocalAnnotationRecord {
  anchor: string;
  source_excerpt: {
    line: number;
    start_line: number;
    end_line: number;
    text: string;
  } | null;
}

export const localAnnotations = new Hono<AppEnv>();
localAnnotations.use("*", requireAuth);
localAnnotations.use("/:owner/:repo/*", requireMembership());

localAnnotations.get("/:owner/:repo/local-annotations/unresolved", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const resolved = resolveLocalWorkspace(c.get("localRegistry"), owner, repo);
  if (!resolved) return c.json(...notFound("workspace not found"));

  const sidecar = readAnnotationSidecar(resolved.entry.path);
  if (!sidecar.ok) return c.json(...bad(sidecar.error));

  const queue = await unresolvedQueue(resolved.entry, sidecar.records);
  return c.json({
    annotations: queue,
    count: queue.length,
    sidecar: SIDECAR_PATH,
  });
});

type SidecarRead = { ok: true; records: LocalAnnotationRecord[] } | { ok: false; error: string };

function readAnnotationSidecar(root: string): SidecarRead {
  const path = join(root, SIDECAR_PATH);
  if (!existsSync(path)) return { ok: true, records: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (_err) {
    return { ok: false, error: "invalid local annotations sidecar JSON" };
  }
  return { ok: true, records: normalizeSidecar(raw) };
}

function normalizeSidecar(raw: unknown): LocalAnnotationRecord[] {
  if (Array.isArray(raw)) return raw.flatMap((entry) => normalizeRecord(entry));
  if (!raw || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  if (Array.isArray(object.annotations)) return object.annotations.flatMap((entry) => normalizeRecord(entry));
  return Object.entries(object).flatMap(([id, entry]) => normalizeRecord(entry, id));
}

function normalizeRecord(raw: unknown, fallbackId = ""): LocalAnnotationRecord[] {
  if (!raw || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  const id = stringField(object.id) ?? fallbackId;
  const path = safeRel(stringField(object.path) ?? undefined);
  if (!id || !path) return [];
  const kind = object.kind === "task" ? "task" : "comment";
  const status = object.status === "resolved" ? "resolved" : "open";
  const messages = Array.isArray(object.messages)
    ? object.messages.flatMap((message) => normalizeMessage(message))
    : Array.isArray(object.thread)
      ? object.thread.flatMap((message) => normalizeMessage(message))
      : [];
  return [{ id: stripLocalPrefix(id), path, kind, status, messages }];
}

function normalizeMessage(raw: unknown): LocalAnnotationMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  const text = stringField(object.text);
  if (!text) return [];
  return [{
    ...(typeof object.author === "string" ? { author: object.author } : {}),
    ...(typeof object.timestamp === "string" ? { timestamp: object.timestamp } : {}),
    text,
  }];
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripLocalPrefix(id: string): string {
  return id.startsWith("local:") ? id.slice("local:".length) : id;
}

async function unresolvedQueue(entry: import("./workspace-registry.js").WorkspaceEntry, records: readonly LocalAnnotationRecord[]): Promise<LocalAnnotationQueueItem[]> {
  const open = records.filter((record) => record.status !== "resolved");
  if (open.length === 0) return [];

  const tree = await entry.backend.getTree(entry.identity.owner, entry.identity.repo, "main", true);
  const markdownPaths = new Set(tree.filter((node) => node.type === "blob" && fileKindForPath(node.path) === "markdown").map((node) => node.path));
  const byPath = new Map<string, LocalAnnotationRecord[]>();
  for (const record of open) {
    if (!markdownPaths.has(record.path)) continue;
    const list = byPath.get(record.path) ?? [];
    list.push(record);
    byPath.set(record.path, list);
  }

  const queue: LocalAnnotationQueueItem[] = [];
  for (const [path, pathRecords] of byPath) {
    const source = await entry.backend.getRawFile(entry.identity.owner, entry.identity.repo, "main", path);
    const anchors = anchorsInSource(source);
    for (const record of pathRecords) {
      const anchor = anchors.get(record.id);
      queue.push({
        ...record,
        anchor: `local:${record.id}`,
        source_excerpt: anchor ? excerptForLine(source, anchor.line) : null,
      });
    }
  }
  return queue.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

function anchorsInSource(source: string): Map<string, { line: number }> {
  const anchors = new Map<string, { line: number }>();
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  for (const match of source.matchAll(LOCAL_ANCHOR_RE)) {
    const id = match[1];
    const offset = match.index ?? 0;
    let line = 1;
    for (let i = 0; i < lineStarts.length; i += 1) {
      if (lineStarts[i] > offset) break;
      line = i + 1;
    }
    anchors.set(id, { line });
  }
  return anchors;
}

function excerptForLine(source: string, line: number): LocalAnnotationQueueItem["source_excerpt"] {
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, line - 2);
  const end = Math.min(lines.length, line + 2);
  return {
    line,
    start_line: start,
    end_line: end,
    text: lines.slice(start - 1, end).join("\n"),
  };
}
