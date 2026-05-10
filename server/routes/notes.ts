import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { writeAtomic } from "../atomic.js";
import { IdConflictError, deleteDocument, indexDocument } from "../indexer.js";
import { getBacklinks } from "../links.js";
import { markSelfWrite, subscribe } from "../watcher.js";
import { streamSSE } from "hono/streaming";

export const notes = new Hono<AppEnv>();

notes.use("*", requireAuth);
notes.use("/:slug/*", requireMembership());

function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

notes.get("/:slug/tree", async (c) => {
  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const out: Array<{
    path: string;
    size: number;
    mtime: number;
    doc?: { id: string; type: string; status: string; title: string | null };
  }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = await fs.stat(full);
        out.push({
          path: path.relative(root, full),
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }

  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));

  const docs = c
    .get("db")
    .prepare("SELECT id, path, type, status, title FROM documents WHERE workspace_id = ?")
    .all(ws.id) as Array<{ id: string; path: string; type: string; status: string; title: string | null }>;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  for (const file of out) {
    const meta = byPath.get(file.path);
    if (meta) file.doc = meta;
  }

  return c.json({ files: out });
});

notes.get("/:slug/note", async (c) => {
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path required", code: "validation" }, 400);
  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path", code: "validation" }, 400);

  try {
    const [content, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
    return c.json({ content, mtime: stat.mtimeMs });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "not found", code: "not_found" }, 404);
    throw err;
  }
});

notes.put("/:slug/note", async (c) => {
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path required", code: "validation" }, 400);
  if (!rel.endsWith(".md"))
    return c.json({ error: "only .md files", code: "validation" }, 400);

  const body = (await c.req.json().catch(() => null)) as
    | { content?: string; expected_mtime?: number }
    | null;
  if (body?.content === undefined)
    return c.json({ error: "content required", code: "validation" }, 400);

  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path", code: "validation" }, 400);

  if (body.expected_mtime !== undefined) {
    try {
      const stat = await fs.stat(full);
      if (Math.floor(stat.mtimeMs) !== Math.floor(body.expected_mtime)) {
        return c.json({ error: "stale", code: "conflict", actual_mtime: stat.mtimeMs }, 409);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  let indexed;
  try {
    indexed = indexDocument(c.get("db"), ws.id, rel, body.content);
  } catch (err) {
    if (err instanceof IdConflictError) {
      return c.json(
        { error: err.message, code: "conflict", conflicting_path: err.existingPath },
        409,
      );
    }
    throw err;
  }

  await writeAtomic(ws.id, root, rel, indexed.content);
  const stat = await fs.stat(full);
  return c.json({
    ok: true,
    mtime: stat.mtimeMs,
    meta: indexed.meta,
    content: indexed.rewrote ? indexed.content : undefined,
  });
});

notes.delete("/:slug/note", async (c) => {
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path required", code: "validation" }, 400);
  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path", code: "validation" }, 400);

  try {
    await fs.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "not found", code: "not_found" }, 404);
    throw err;
  }
  markSelfWrite(ws.id, rel);
  deleteDocument(c.get("db"), ws.id, rel);
  return c.json({ ok: true });
});

notes.get("/:slug/events", (c) => {
  const ws = c.get("workspace");
  const config = c.get("config");
  const db = c.get("db");
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe(db, config, ws.slug, ws.id, (e) => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    });
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: "ready" }), event: "ready" });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(30000);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ data: "{}", event: "ping" });
      }
    } finally {
      unsubscribe();
    }
  });
});

notes.get("/:slug/search", (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ results: [] });
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 25;
  const params = new URL(c.req.url).searchParams;
  const statuses = params.getAll("status");
  const types = params.getAll("type");
  const allowedStatuses = new Set(["golden", "unreviewed", "rejected", "draft", "archived"]);
  const allowedTypes = new Set(["page", "review", "proposal"]);
  if (statuses.some((s) => !allowedStatuses.has(s))) {
    return c.json({ error: "invalid status filter", code: "validation" }, 400);
  }
  if (types.some((t) => !allowedTypes.has(t))) {
    return c.json({ error: "invalid type filter", code: "validation" }, 400);
  }
  const ws = c.get("workspace");
  // Wrap loose query in FTS5 prefix-token form, OR-joined.
  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `${t.replace(/["]/g, "")}*`)
    .join(" OR ");
  if (!ftsQuery) return c.json({ results: [] });

  let rows: Array<{
    doc_id: string;
    path: string;
    title: string;
    type: string;
    status: string;
    target_id: string | null;
    snippet: string;
    rank: number;
  }>;
  const filters: string[] = ["notes_fts.workspace_id = ?", "notes_fts MATCH ?"];
  const args: Array<string | number> = [ws.id, ftsQuery];
  if (statuses.length > 0) {
    filters.push(`documents.status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (types.length > 0) {
    filters.push(`documents.type IN (${types.map(() => "?").join(", ")})`);
    args.push(...types);
  }
  args.push(limit);
  try {
    rows = c
      .get("db")
      .prepare(
        `SELECT notes_fts.doc_id AS doc_id,
                notes_fts.path AS path,
                notes_fts.title AS title,
                documents.type AS type,
                documents.status AS status,
                documents.target_id AS target_id,
                snippet(notes_fts, 4, '<mark>', '</mark>', '...', 16) AS snippet,
                bm25(notes_fts) AS rank
           FROM notes_fts
           JOIN documents
             ON documents.workspace_id = notes_fts.workspace_id
            AND documents.id = notes_fts.doc_id
          WHERE ${filters.join(" AND ")}
          ORDER BY rank LIMIT ?`,
      )
      .all(...args) as typeof rows;
  } catch (err) {
    return c.json({ error: `search failed: ${(err as Error).message}`, code: "validation" }, 400);
  }
  return c.json({ results: rows });
});

notes.get("/:slug/backlinks", (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required", code: "validation" }, 400);
  const ws = c.get("workspace");
  return c.json({ backlinks: getBacklinks(c.get("db"), ws.id, id) });
});

notes.get("/:slug/documents", (c) => {
  const params = new URL(c.req.url).searchParams;
  const statuses = params.getAll("status");
  const types = params.getAll("type");
  const allowedStatuses = new Set(["golden", "unreviewed", "rejected", "draft", "archived"]);
  const allowedTypes = new Set(["page", "review", "proposal"]);
  if (statuses.some((s) => !allowedStatuses.has(s))) {
    return c.json({ error: "invalid status filter", code: "validation" }, 400);
  }
  if (types.some((t) => !allowedTypes.has(t))) {
    return c.json({ error: "invalid type filter", code: "validation" }, 400);
  }
  const ws = c.get("workspace");
  const filters: string[] = ["workspace_id = ?"];
  const args: Array<string | number> = [ws.id];
  if (statuses.length > 0) {
    filters.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    args.push(...statuses);
  }
  if (types.length > 0) {
    filters.push(`type IN (${types.map(() => "?").join(", ")})`);
    args.push(...types);
  }
  const rows = c
    .get("db")
    .prepare(
      `SELECT id, path, type, status, target_id, title, mtime FROM documents WHERE ${filters.join(" AND ")} ORDER BY path`,
    )
    .all(...args);
  return c.json({ documents: rows });
});
