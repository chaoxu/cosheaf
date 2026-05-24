import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { getCachedTree, invalidateBranchTree, setCachedTree } from "../tree-cache.js";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
} from "../../shared/conventions.js";
import type { WorkspaceValidation } from "../../shared/validation.js";
import { bad, conflict, notFound } from "./responses.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:slug/*", requireMembership());
files.use("/:slug/*", requireWriteOnMutation);

// Repository-relative path validator. Rejects absolute paths, traversal
// segments (`..`), empty segments, backslashes (Forgejo treats `/` as the
// only separator), control characters, and encoded-traversal forms. Exported
// so other typed routes (e.g. PR review-comment paths) can apply the same
// shape check.
export function safeRel(p: string | undefined): string | null {
  if (!p) return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || p[i] === "\\") return null;
  }
  if (p.split(/[/\\]/).some((seg) => seg === ".." || seg === "")) return null;
  if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) return null;
  return p;
}

// Resolve which Forgejo ref to read/write from. Caller passes ?branch=<name>;
// missing/blank means `main`. We don't validate "is this user's branch" — that
// is Forgejo's job (push rejections via branch protection).
function refFromQuery(c: import("hono").Context<AppEnv>): string {
  const b = c.req.query("branch")?.trim();
  return b && b.length > 0 ? b : "main";
}

// Auto-create the target branch from `main` if it doesn't exist. Any valid
// branch name is allowed — cosheaf's job is to be a thin shell over Forgejo's
// branch model, not to enforce a naming convention Forgejo itself doesn't
// require. Write-member gating happens upstream via requireWriteOnMutation.
async function ensureBranch(
  c: import("hono").Context<AppEnv>,
  branch: string,
): Promise<void> {
  if (branch === "main") return;
  const { fj, owner, repo } = c.get("repoCtx");
  const exists = await fj.getBranch(owner, repo, branch);
  if (exists) return;
  await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
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
  let tree = getCachedTree(owner, repo, ref);
  if (!tree) {
    try {
      tree = await fj.getTree(owner, repo, ref, true);
      setCachedTree(owner, repo, ref, tree);
    } catch (err) {
      // Forgejo returns 404 for a missing ref *or* 400 with "sha not found"
      // for a branch that was deleted while a client still held its name
      // (e.g. squash-merge dropped the head branch). Either way, fall back
      // to main so a stale tab keeps rendering.
      const missing =
        err instanceof ForgejoError &&
        (err.status === 404 || (err.status === 400 && /sha not found/i.test(err.bodyText)));
      if (missing && ref !== "main") {
        tree = getCachedTree(owner, repo, "main") ?? (await fj.getTree(owner, repo, "main", true));
        setCachedTree(owner, repo, "main", tree);
      } else {
        throw err;
      }
    }
  }
  const out = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => ({ path: e.path, size: e.size ?? 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const docs = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, forgejo_id AS path, title FROM doc_map WHERE workspace_slug = ?",
    )
    .all(ws.slug) as Array<{ id: string; path: string; title: string | null }>;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const merged = out.map((f) => {
    const meta = byPath.get(f.path);
    return meta
      ? { ...f, doc: { id: meta.id, title: meta.title } }
      : f;
  });
  return c.json({ files: merged });
});

files.get("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel) return c.json(...bad("path required"));
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
          return c.json(...notFound());
        throw err2;
      }
    }
    if (err instanceof ForgejoError && err.status === 404)
      return c.json(...notFound());
    throw err;
  }
});

files.put("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !rel.endsWith(".md"))
    return c.json(...bad("invalid path"));
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json(...bad("branch required (cannot write to main)"));
  const body = (await c.req.json().catch(() => null)) as { content?: string; previous_path?: string } | null;
  if (body?.content === undefined)
    return c.json(...bad("content required"));
  const previousRel = safeRel(body.previous_path);
  if (body.previous_path !== undefined && !previousRel)
    return c.json(...bad("invalid previous_path"));

  await ensureBranch(c, branch);
  const { fj, owner, repo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const db = c.get("db");
  const hub = c.get("sse");

  // Pass the workspace's declared markdown format explicitly so passthrough
  // workspaces don't inherit coflat indexing behavior (e.g. backlink
  // extraction for `[@id]` references). #25.
  const plan = planIndexPage(db, {
    workspaceSlug: ws.slug,
    filePath: rel,
    bodyText: body.content,
    formatId: ws.defaultMdFormat,
  });
  const finalContent = plan.rewrittenContent ?? body.content;

  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await fj.getFileMeta(owner, repo, branch, rel);
  if (isRename && existing)
    return c.json(...conflict("destination already exists"));
  const previous = isRename ? await fj.getFileMeta(owner, repo, branch, previousRel as string) : null;
  let r;
  try {
    r = await fj.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
    });
    if (isRename && previous) {
      await fj.deleteFile(owner, repo, {
        branch,
        path: previousRel as string,
        sha: previous.sha,
        message: `remove ${previousRel} after rename`,
      });
    }
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409)
      return c.json(...conflict("conflict on push"));
    throw err;
  }
  // Commit the sidecar reindex now that the canonical write succeeded.
  // Without this, doc_map / FTS / backlinks would lag until the webhook
  // fires and typed read-after-write (search, suggest, /backlinks) breaks.
  plan.commit();
  if (isRename) deletePage(db, ws.slug, previousRel as string);
  invalidateBranchTree(owner, repo, branch);
  if (isRename) hub.publish(ws.slug, { type: "change", path: previousRel as string });
  hub.publish(ws.slug, { type: "change", path: rel });
  return c.json({
    ok: true,
    branch,
    meta: { id: plan.cosheafId, title: plan.title },
    content: plan.rewrittenContent ?? undefined,
    commit: r.commit?.sha,
  });
});

files.post("/:slug/assets", async (c) => {
  const branch = c.req.query("branch")?.trim();
  if (!branch)
    return c.json(...bad("branch required"));
  if (branch === "main")
    return c.json(...bad("branch required (cannot upload assets to main)"));
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return c.json(...bad("file field required"));
  if (file.size > MAX_ASSET_BYTES)
    return c.json(...bad(`asset exceeds ${MAX_ASSET_DISPLAY}`));
  const { fj, owner, repo } = c.get("repoCtx");
  await ensureBranch(c, branch);
  // Random-prefixed under assets/ so two simultaneous uploads of the same
  // filename don't collide. We don't try to dedupe by content hash here;
  // git already deduplicates blobs server-side.
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "asset";
  const rand = Math.random().toString(36).slice(2, 10);
  const assetPath = `assets/${rand}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await fj.putFileBytes(owner, repo, {
    branch,
    path: assetPath,
    content: bytes,
    message: `upload ${safeName}`,
  });
  invalidateBranchTree(owner, repo, branch);
  return c.json({ path: assetPath });
});

files.get("/:slug/suggest", (c) => {
  const prefix = c.req.query("prefix")?.trim() ?? "";
  const trigger = c.req.query("trigger") ?? "[@";
  const rawLimit = Number(c.req.query("limit") ?? 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 10;
  const ws = c.get("workspace");
  // For `[@` trigger we suggest from doc_map (cross-ref ids + titles).
  // Other triggers return empty until we add e.g. tag completion.
  if (trigger !== "[@") return c.json({ suggestions: [] });
  const term = `${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, title FROM doc_map " +
        "WHERE workspace_slug = ? AND " +
        "(cosheaf_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') " +
        "ORDER BY length(cosheaf_id), cosheaf_id LIMIT ?",
    )
    .all(ws.slug, term, term, limit) as Array<{ id: string; title: string | null }>;
  return c.json({
    suggestions: rows.map((r) => ({
      id: r.id,
      insert: `${r.id}]`,
      display: r.title ? `${r.id} — ${r.title}` : r.id,
    })),
  });
});

files.delete("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !rel.endsWith(".md"))
    return c.json(...bad("invalid path"));
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json(...bad("branch required (cannot delete on main)"));
  await ensureBranch(c, branch);
  const { fj, owner, repo } = c.get("repoCtx");
  const meta = await fj.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json(...notFound());
  await fj.deleteFile(owner, repo, {
    branch,
    path: rel,
    sha: meta.sha,
    message: `delete ${rel}`,
  });
  invalidateBranchTree(owner, repo, branch);
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
  let rows: Array<{ doc_id: string; path: string; title: string | null; body: string; rank: number }>;
  try {
    rows = c
      .get("db")
      .prepare(
        `SELECT cosheaf_id AS doc_id, path, title, body, bm25(notes_fts) AS rank
           FROM notes_fts
          WHERE workspace_slug = ? AND notes_fts MATCH ?
          ORDER BY rank LIMIT ?`,
      )
      .all(ws.slug, ftsQuery, limit) as typeof rows;
  } catch (err) {
    return c.json(...bad(`search failed: ${(err as Error).message}`));
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
          `SELECT cosheaf_id AS doc_id, path, title, body
             FROM notes_fts
            WHERE workspace_slug = ? AND (${where})
            ORDER BY path LIMIT ?`,
        )
        .all(ws.slug, ...args, limit) as Array<{ doc_id: string; path: string; title: string | null; body: string }>;
      rows = fallbackRows.map((r) => ({ ...r, rank: 0 }));
    }
  }
  return c.json({
    results: rows.map((r) => ({
      doc_id: r.doc_id,
      path: r.path,
      title: r.title,
      snippet: plainSnippet(r, terms),
      rank: r.rank,
    })),
  });
});

files.get("/:slug/backlinks", (c) => {
  const id = c.req.query("id");
  if (!id) return c.json(...bad("id required"));
  const ws = c.get("workspace");
  const rows = c
    .get("db")
    .prepare(
      `SELECT backlinks.src_id AS src_id, backlinks.src_path AS src_path,
              doc_map.title AS src_title, backlinks.target_label AS target_label
         FROM backlinks
         LEFT JOIN doc_map
           ON doc_map.workspace_slug = backlinks.workspace_slug
          AND doc_map.cosheaf_id = backlinks.src_id
        WHERE backlinks.workspace_slug = ? AND backlinks.target_id = ?
        ORDER BY backlinks.src_path`,
    )
    .all(ws.slug, id);
  return c.json({ backlinks: rows });
});

files.get("/:slug/validation", (c) => {
  const ws = c.get("workspace");
  const db = c.get("db");
  const brokenRefs = db
    .prepare(
      `SELECT b.src_id AS source_id,
              b.src_path AS source_path,
              src.title AS source_title,
              b.target_id AS target_id,
              b.target_label AS target_label,
              b.line AS line
         FROM backlinks b
         LEFT JOIN doc_map src
           ON src.workspace_slug = b.workspace_slug
          AND src.cosheaf_id = b.src_id
         LEFT JOIN doc_map target
           ON target.workspace_slug = b.workspace_slug
          AND target.cosheaf_id = b.target_id
        WHERE b.workspace_slug = ?
          AND (b.target_id IS NULL OR target.cosheaf_id IS NULL)
        ORDER BY b.src_path, b.line, b.target_label`,
    )
    .all(ws.slug) as WorkspaceValidation["broken_refs"];
  const orphanLabels = db
    .prepare(
      `SELECT d.cosheaf_id AS id,
              d.forgejo_id AS path,
              d.title AS title
         FROM doc_map d
         LEFT JOIN backlinks b
           ON b.workspace_slug = d.workspace_slug
          AND b.target_id = d.cosheaf_id
          AND b.src_id != d.cosheaf_id
        WHERE d.workspace_slug = ?
          AND b.src_id IS NULL
        ORDER BY d.forgejo_id`,
    )
    .all(ws.slug) as WorkspaceValidation["orphan_labels"];
  return c.json({ broken_refs: brokenRefs, orphan_labels: orphanLabels } satisfies WorkspaceValidation);
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
