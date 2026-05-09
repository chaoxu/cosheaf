import { promises as fs, watch as fsWatch } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Config } from "./db.js";
import { workspaceDir } from "./db.js";
import { deleteDocument, indexDocument } from "./indexer.js";

export interface FileEvent {
  type: "change" | "remove";
  path: string;
  doc?: { id: string; type: string; status: string; title: string | null };
}

type Listener = (e: FileEvent) => void;

interface Workspace {
  id: number;
  slug: string;
  root: string;
  listeners: Set<Listener>;
  pendingTimers: Map<string, NodeJS.Timeout>;
  /** Paths recently written by our own routes — skip the resulting watcher event. */
  selfWrites: Map<string, NodeJS.Timeout>;
}

const workspaces = new Map<number, Workspace>();
const SELF_WRITE_WINDOW_MS = 750;
const DEBOUNCE_MS = 60;

function getOrCreate(
  db: Database.Database,
  config: Config,
  slug: string,
  workspaceId: number,
): Workspace {
  let ws = workspaces.get(workspaceId);
  if (ws) return ws;
  ws = {
    id: workspaceId,
    slug,
    root: workspaceDir(config, slug),
    listeners: new Set(),
    pendingTimers: new Map(),
    selfWrites: new Map(),
  };
  workspaces.set(workspaceId, ws);
  startWatcher(db, ws);
  return ws;
}

function startWatcher(db: Database.Database, ws: Workspace): void {
  let watcher;
  try {
    watcher = fsWatch(ws.root, { recursive: true });
  } catch (err) {
    console.warn(`[watcher] cannot watch ${ws.root}:`, (err as Error).message);
    return;
  }
  watcher.on("error", (err) => {
    console.warn(`[watcher] ${ws.slug} error:`, err.message);
  });
  watcher.on("change", (_event, filename) => {
    if (!filename) return;
    const rel = String(filename);
    if (!rel.endsWith(".md")) return;
    if (rel.includes(".tmp-")) return;
    const existing = ws.pendingTimers.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      ws.pendingTimers.delete(rel);
      reconcile(db, ws, rel).catch((err) => {
        console.warn(`[watcher] ${ws.slug} reconcile ${rel}:`, err.message);
      });
    }, DEBOUNCE_MS);
    ws.pendingTimers.set(rel, timer);
  });
}

async function reconcile(db: Database.Database, ws: Workspace, rel: string): Promise<void> {
  if (ws.selfWrites.has(rel)) {
    const timer = ws.selfWrites.get(rel);
    if (timer) clearTimeout(timer);
    ws.selfWrites.delete(rel);
    return;
  }
  const full = path.join(ws.root, rel);
  let content: string | null = null;
  try {
    content = await fs.readFile(full, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (content === null) {
    deleteDocument(db, ws.id, rel);
    emit(ws, { type: "remove", path: rel });
    return;
  }
  const indexed = indexDocument(db, ws.id, rel, content);
  emit(ws, {
    type: "change",
    path: rel,
    doc: {
      id: indexed.meta.id,
      type: indexed.meta.type,
      status: indexed.meta.status,
      title: indexed.meta.title,
    },
  });
}

function emit(ws: Workspace, e: FileEvent): void {
  for (const fn of ws.listeners) fn(e);
}

export function subscribe(
  db: Database.Database,
  config: Config,
  slug: string,
  workspaceId: number,
  fn: Listener,
): () => void {
  const ws = getOrCreate(db, config, slug, workspaceId);
  ws.listeners.add(fn);
  return () => ws.listeners.delete(fn);
}

/** Mark a path as written by our own request handler. Suppresses the next watcher event. */
export function markSelfWrite(workspaceId: number, rel: string): void {
  const ws = workspaces.get(workspaceId);
  if (!ws) return;
  const existing = ws.selfWrites.get(rel);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => ws.selfWrites.delete(rel), SELF_WRITE_WINDOW_MS);
  ws.selfWrites.set(rel, timer);
}
