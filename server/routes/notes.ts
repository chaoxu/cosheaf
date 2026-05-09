import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppEnv } from "../types.js";
import { workspaceDir } from "../db.js";
import { requireAuth, requireMembership } from "../middleware.js";

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
  const out: Array<{ path: string; size: number; mtime: number }> = [];

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

  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, body.content, "utf8");
  await fs.rename(tmp, full);
  const stat = await fs.stat(full);
  return c.json({ ok: true, mtime: stat.mtimeMs });
});
