import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { planIndexPage } from "../indexer.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:slug/*", requireMembership());

function safeRel(p: string | undefined): string | null {
  if (!p) return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || p[i] === "\\") return null;
  }
  if (p.split(/[/\\]/).some((seg) => seg === ".." || seg === "")) return null;
  if (/%2e%2e/i.test(p) || /%2f/i.test(p)) return null;
  return p;
}

// Resolve which Forgejo ref to read/write from. Caller passes ?branch=<name>;
// missing/blank means `main`. We don't validate "is this user's branch" — that
// is Forgejo's job (push rejections via branch protection).
function refFromQuery(c: import("hono").Context<AppEnv>): string {
  const b = c.req.query("branch")?.trim();
  return b && b.length > 0 ? b : "main";
}

// Auto-create the target branch from `main` if it doesn't exist, but only if
// the name is prefixed with `user/<sudo>/` — otherwise reject. Without this
// gate, `PUT /file?branch=<arbitrary>` is an unbounded branch-creation
// primitive for any write member (including misbehaving clients).
async function ensureBranch(
  c: import("hono").Context<AppEnv>,
  branch: string,
): Promise<"ok" | "forbidden"> {
  if (branch === "main") return "ok";
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const exists = await fj.getBranch(owner, repo, branch);
  if (exists) return "ok";
  if (!branch.startsWith(`user/${sudo}/`)) return "forbidden";
  await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main", sudo });
  return "ok";
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function searchTerms(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, " ").trim())
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => t.length > 0);
}

export function buildFtsQuery(q: string): string {
  return searchTerms(q)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

type SnippetPart = { text: string; match: boolean };

function plainSnippet(row: { title: string | null; body: string }, terms: string[]): SnippetPart[] {
  const source = row.body || row.title || "";
  const lower = source.toLocaleLowerCase();
  const term = terms.find((t) => lower.includes(t.toLocaleLowerCase())) ?? terms[0] ?? "";
  if (!term) return [{ text: source.slice(0, 160), match: false }];
  const idx = lower.indexOf(term.toLocaleLowerCase());
  if (idx < 0) return [{ text: source.slice(0, 160), match: false }];
  const start = Math.max(0, idx - 64);
  const end = Math.min(source.length, idx + term.length + 96);
  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: "...", match: false });
  const before = source.slice(start, idx);
  if (before) parts.push({ text: before, match: false });
  parts.push({ text: source.slice(idx, idx + term.length), match: true });
  const after = source.slice(idx + term.length, end);
  if (after) parts.push({ text: after, match: false });
  if (end < source.length) parts.push({ text: "...", match: false });
  return parts;
}

files.get("/:slug/tree", async (c) => {
  const ws = c.get("workspace");
  const { fj, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  let tree;
  try {
    tree = await fj.getTree(owner, repo, ref, true);
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      tree = await fj.getTree(owner, repo, "main", true);
    } else {
      throw err;
    }
  }
  const out = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => ({ path: e.path, size: e.size ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const docs = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, forgejo_id AS path, title FROM doc_map WHERE workspace_id = ? AND doc_type = 'page'",
    )
    .all(ws.id) as Array<{ id: string; path: string; title: string | null }>;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const merged = out.map((f) => {
    const meta = byPath.get(f.path);
    return meta
      ? { ...f, doc: { id: meta.id, type: "page" as const, status: "golden" as const, title: meta.title } }
      : f;
  });
  return c.json({ files: merged });
});

files.get("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel) return c.json({ error: "path required", code: "validation" }, 400);
  const { fj, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  try {
    const content = await fj.getRawFile(owner, repo, ref, rel);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      // File not on the branch — fall back to main so the editor can still
      // show the canonical version.
      try {
        const content = await fj.getRawFile(owner, repo, "main", rel);
        return c.json({ content });
      } catch (err2) {
        if (err2 instanceof ForgejoError && err2.status === 404)
          return c.json({ error: "not found", code: "not_found" }, 404);
        throw err2;
      }
    }
    if (err instanceof ForgejoError && err.status === 404)
      return c.json({ error: "not found", code: "not_found" }, 404);
    throw err;
  }
});

files.put("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !rel.endsWith(".md"))
    return c.json({ error: "invalid path", code: "validation" }, 400);
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json({ error: "branch required (cannot write to main)", code: "validation" }, 400);
  const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
  if (body?.content === undefined)
    return c.json({ error: "content required", code: "validation" }, 400);

  const ensured = await ensureBranch(c, branch);
  if (ensured === "forbidden")
    return c.json({ error: "branch name must be `user/<you>/...`", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const db = c.get("db");

  const plan = planIndexPage(db, { workspaceId: ws.id, filePath: rel, bodyText: body.content });
  const finalContent = plan.rewrittenContent ?? body.content;

  const existing = await fj.getFileMeta(owner, repo, branch, rel);
  let r;
  try {
    r = await fj.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: existing ? `update ${rel}` : `create ${rel}`,
      sudo,
    });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409)
      return c.json({ error: "conflict on push", code: "conflict" }, 409);
    throw err;
  }
  return c.json({
    ok: true,
    branch,
    meta: { id: plan.cosheafId, type: "page", status: "golden", title: plan.title },
    content: plan.rewrittenContent ?? undefined,
    commit: r.commit?.sha,
  });
});

files.delete("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !rel.endsWith(".md"))
    return c.json({ error: "invalid path", code: "validation" }, 400);
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json({ error: "branch required (cannot delete on main)", code: "validation" }, 400);
  const ensured = await ensureBranch(c, branch);
  if (ensured === "forbidden")
    return c.json({ error: "branch name must be `user/<you>/...`", code: "forbidden" }, 403);
  const { fj, owner, repo, sudo } = c.get("repoCtx");
  const meta = await fj.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json({ error: "not found", code: "not_found" }, 404);
  await fj.deleteFile(owner, repo, {
    branch,
    path: rel,
    sha: meta.sha,
    message: `delete ${rel}`,
    sudo,
  });
  return c.json({ ok: true, branch });
});

files.get("/:slug/search", (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ results: [] });
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 25;
  const ws = c.get("workspace");
  const terms = searchTerms(q);
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) return c.json({ results: [] });
  let rows: Array<{ doc_id: string; path: string; title: string | null; type: string; body: string; rank: number }>;
  try {
    rows = c
      .get("db")
      .prepare(
        `SELECT cosheaf_id AS doc_id, path, title,
                doc_type AS type, body,
                bm25(notes_fts) AS rank
           FROM notes_fts
          WHERE workspace_id = ? AND notes_fts MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .all(ws.id, ftsQuery, limit) as typeof rows;
  } catch (err) {
    return c.json({ error: `search failed: ${(err as Error).message}`, code: "validation" }, 400);
  }
  if (rows.length === 0) {
    const patterns = terms.map((t) => `%${likeEscape(t)}%`);
    if (patterns.length > 0) {
      const where = patterns
        .map(() => "(path LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
        .join(" OR ");
      const args = patterns.flatMap((p) => [p, p, p]);
      const fallbackRows = c
        .get("db")
        .prepare(
          `SELECT cosheaf_id AS doc_id, path, title, doc_type AS type, body
             FROM notes_fts
            WHERE workspace_id = ? AND (${where})
            ORDER BY path LIMIT ?`,
        )
        .all(ws.id, ...args, limit) as Array<{ doc_id: string; path: string; title: string | null; type: string; body: string }>;
      rows = fallbackRows.map((r) => ({
        doc_id: r.doc_id,
        path: r.path,
        title: r.title,
        type: r.type,
        body: r.body,
        rank: 0,
      }));
    }
  }
  return c.json({
    results: rows.map((r) => ({
      doc_id: r.doc_id,
      path: r.path,
      title: r.title,
      type: r.type,
      status: "golden",
      target_id: null,
      snippet: plainSnippet(r, terms),
      rank: r.rank,
    })),
  });
});

files.get("/:slug/backlinks", (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id required", code: "validation" }, 400);
  const ws = c.get("workspace");
  const rows = c
    .get("db")
    .prepare(
      `SELECT backlinks.src_id AS src_id, backlinks.src_path AS src_path,
              doc_map.title AS src_title, backlinks.target_label AS target_label
         FROM backlinks
         LEFT JOIN doc_map
           ON doc_map.workspace_id = backlinks.workspace_id
          AND doc_map.cosheaf_id = backlinks.src_id
        WHERE backlinks.workspace_id = ? AND backlinks.target_id = ?
        ORDER BY backlinks.src_path`,
    )
    .all(ws.id, id);
  return c.json({ backlinks: rows });
});

files.get("/:slug/events", (c) => {
  const ws = c.get("workspace");
  const hub = c.get("sse");
  return streamSSE(c, async (stream) => {
    const unsub = hub.subscribe(ws.slug, (e: import("../sse.js").SSEEvent) => {
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
      unsub();
    }
  });
});
