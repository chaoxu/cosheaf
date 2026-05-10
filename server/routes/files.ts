import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { planIndexPage } from "../indexer.js";
import {
  createChange,
  getChange,
  listOpenDraftsForUser,
  setChangeState,
  type ChangeRow,
} from "../changes.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:slug/*", requireMembership());

function safeRel(p: string | undefined): string | null {
  if (!p) return null;
  if (p.includes("\0") || p.startsWith("/") || p.includes("..")) return null;
  return p;
}

// Resolve which change to write to. Rules:
// - explicit change_id → that change (must be draft, must belong to user)
// - no change_id, zero open drafts → lazily create one
// - no change_id, exactly one open draft → use it
// - no change_id, multiple open drafts → 400 ambiguous
type ResolveError = { error: string; code: "not_found" | "forbidden" | "conflict" | "ambiguous" };

const STATUS_FOR_CODE: Record<ResolveError["code"], 400 | 403 | 404 | 409> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  ambiguous: 400,
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function fallbackSnippet(row: { title: string | null; body: string }, terms: string[]): string {
  const source = row.body || row.title || "";
  const lower = source.toLocaleLowerCase();
  const term = terms.find((t) => lower.includes(t.toLocaleLowerCase())) ?? terms[0] ?? "";
  if (!term) return htmlEscape(source.slice(0, 160));
  const idx = lower.indexOf(term.toLocaleLowerCase());
  if (idx < 0) return htmlEscape(source.slice(0, 160));
  const start = Math.max(0, idx - 64);
  const end = Math.min(source.length, idx + term.length + 96);
  const before = source.slice(start, idx);
  const match = source.slice(idx, idx + term.length);
  const after = source.slice(idx + term.length, end);
  return `${start > 0 ? "..." : ""}${htmlEscape(before)}<mark>${htmlEscape(match)}</mark>${htmlEscape(after)}${end < source.length ? "..." : ""}`;
}

async function resolveWriteChange(c: import("hono").Context<AppEnv>): Promise<ChangeRow | ResolveError> {
  const ws = c.get("workspace");
  const user = c.get("user");
  const db = c.get("db");
  const explicit = c.req.query("change_id");
  if (explicit) {
    const change = getChange(db, ws.id, explicit);
    if (!change) return { error: "change not found", code: "not_found" };
    if (change.state !== "draft") return { error: `change is ${change.state}; cannot write`, code: "conflict" };
    if (change.author_user_id !== user.id) return { error: "not your change", code: "forbidden" };
    return change;
  }
  const drafts = listOpenDraftsForUser(db, ws.id, user.id);
  if (drafts.length === 1) {
    const draft = drafts[0];
    if (draft) return draft;
  }
  if (drafts.length > 1) {
    return {
      error: `multiple open drafts (${drafts.map((d) => d.id).join(", ")}); pass change_id explicitly`,
      code: "ambiguous",
    };
  }
  // Zero drafts → create one. Branch is created lazily on first putFile below.
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const mainBranch = await fj.getBranch(owner, ws.forgejoRepo, "main");
  return createChange(db, {
    workspaceId: ws.id,
    authorUserId: user.id,
    baseSha: mainBranch?.commit?.id ?? null,
  });
}

// For reads (get/tree): resolve the ref to read from.
// - explicit change_id → that change's branch
// - else if user has exactly one open draft → that draft's branch (the historical "working branch" feel)
// - else → main
async function resolveReadRef(c: import("hono").Context<AppEnv>): Promise<{ ref: string; change: ChangeRow | null }> {
  const ws = c.get("workspace");
  const user = c.get("user");
  const db = c.get("db");
  const explicit = c.req.query("change_id");
  if (explicit) {
    const change = getChange(db, ws.id, explicit);
    if (change && change.state !== "abandoned") return { ref: change.branch_name, change };
    // Fall through to main if change is abandoned/missing.
  }
  if (!explicit) {
    const drafts = listOpenDraftsForUser(db, ws.id, user.id);
    if (drafts.length === 1) {
      // Verify the branch still exists; if it was deleted (publish merged it),
      // the change will have been transitioned. Be defensive.
      const draft = drafts[0];
      if (draft) return { ref: draft.branch_name, change: draft };
    }
  }
  return { ref: "main", change: null };
}

async function ensureChangeBranch(
  c: import("hono").Context<AppEnv>,
  change: ChangeRow,
): Promise<void> {
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");
  const exists = await fj.getBranch(owner, c.get("workspace").forgejoRepo, change.branch_name);
  if (exists) return;
  await fj.createBranch(owner, c.get("workspace").forgejoRepo, {
    newBranchName: change.branch_name,
    oldBranchName: "main",
    sudo,
  });
}

files.get("/:slug/tree", async (c) => {
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const { ref } = await resolveReadRef(c);
  let tree;
  try {
    tree = await fj.getTree(owner, ws.forgejoRepo, ref, true);
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      // change branch missing (e.g. merged); fall back to main
      tree = await fj.getTree(owner, ws.forgejoRepo, "main", true);
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
  const ws = c.get("workspace");
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const { ref } = await resolveReadRef(c);
  try {
    const content = await fj.getRawFile(owner, ws.forgejoRepo, ref, rel);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      // Change branch may not have this file yet — fall back to main.
      try {
        const content = await fj.getRawFile(owner, ws.forgejoRepo, "main", rel);
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
  const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
  if (body?.content === undefined)
    return c.json({ error: "content required", code: "validation" }, 400);

  const resolved = await resolveWriteChange(c);
  if ("error" in resolved) return c.json(resolved, STATUS_FOR_CODE[resolved.code]);
  const change = resolved;

  await ensureChangeBranch(c, change);
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");
  const ws = c.get("workspace");
  const db = c.get("db");

  const plan = planIndexPage(db, { workspaceId: ws.id, filePath: rel, bodyText: body.content });
  const finalContent = plan.rewrittenContent ?? body.content;

  const existing = await fj.getFileMeta(owner, ws.forgejoRepo, change.branch_name, rel);
  let r;
  try {
    r = await fj.putFile(owner, ws.forgejoRepo, {
      branch: change.branch_name,
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
  setChangeState(db, ws.id, change.id, change.state); // bumps updated_at
  return c.json({
    ok: true,
    change_id: change.id,
    meta: { id: plan.cosheafId, type: "page", status: "golden", title: plan.title },
    content: plan.rewrittenContent ?? undefined,
    commit: r.commit?.sha,
    pending: true,
  });
});

files.delete("/:slug/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel) return c.json({ error: "path required", code: "validation" }, 400);
  const resolved = await resolveWriteChange(c);
  if ("error" in resolved) return c.json(resolved, STATUS_FOR_CODE[resolved.code]);
  const change = resolved;
  await ensureChangeBranch(c, change);
  const fj = c.get("forgejo");
  const owner = c.get("config").forgejoOwner;
  const sudo = c.get("forgejoUsername");
  const ws = c.get("workspace");
  const meta = await fj.getFileMeta(owner, ws.forgejoRepo, change.branch_name, rel);
  if (!meta) return c.json({ error: "not found", code: "not_found" }, 404);
  await fj.deleteFile(owner, ws.forgejoRepo, {
    branch: change.branch_name,
    path: rel,
    sha: meta.sha,
    message: `delete ${rel}`,
    sudo,
  });
  setChangeState(c.get("db"), ws.id, change.id, change.state);
  return c.json({ ok: true, change_id: change.id, pending: true });
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
  let rows: Array<{ doc_id: string; path: string; title: string; type: string; snippet: string; rank: number }>;
  try {
    rows = c
      .get("db")
      .prepare(
        `SELECT cosheaf_id AS doc_id, path, title,
                doc_type AS type,
                snippet(notes_fts, 5, '<mark>', '</mark>', '...', 16) AS snippet,
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
        title: r.title ?? "",
        type: r.type,
        snippet: fallbackSnippet(r, terms),
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
      snippet: r.snippet,
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
