import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { IdConflictError, deleteDocument, indexDocument } from "../indexer.js";

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
  if (!rel) return c.json({ error: "path required" }, 400);
  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path" }, 400);

  try {
    const [content, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
    return c.json({ content, mtime: stat.mtimeMs });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "not found" }, 404);
    throw err;
  }
});

notes.put("/:slug/note", async (c) => {
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path required" }, 400);
  if (!rel.endsWith(".md")) return c.json({ error: "only .md files" }, 400);

  const body = (await c.req.json().catch(() => null)) as
    | { content?: string; expected_mtime?: number }
    | null;
  if (body?.content === undefined) return c.json({ error: "content required" }, 400);

  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path" }, 400);

  if (body.expected_mtime !== undefined) {
    try {
      const stat = await fs.stat(full);
      if (Math.floor(stat.mtimeMs) !== Math.floor(body.expected_mtime)) {
        return c.json({ error: "stale", actual_mtime: stat.mtimeMs }, 409);
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
      return c.json({ error: err.message, conflicting_path: err.existingPath }, 409);
    }
    throw err;
  }

  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, indexed.content, "utf8");
  await fs.rename(tmp, full);
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
  if (!rel) return c.json({ error: "path required" }, 400);
  const config = c.get("config");
  const ws = c.get("workspace");
  const root = workspaceDir(config, ws.slug);
  const full = safeJoin(root, rel);
  if (!full) return c.json({ error: "invalid path" }, 400);

  try {
    await fs.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "not found" }, 404);
    throw err;
  }
  deleteDocument(c.get("db"), ws.id, rel);
  return c.json({ ok: true });
});

notes.get("/:slug/documents", (c) => {
  const ws = c.get("workspace");
  const rows = c
    .get("db")
    .prepare(
      "SELECT id, path, type, status, target_id, title, mtime " +
        "FROM documents WHERE workspace_id = ? ORDER BY path",
    )
    .all(ws.id);
  return c.json({ documents: rows });
});
