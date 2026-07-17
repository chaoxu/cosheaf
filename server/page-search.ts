// Full-text page search over the SQLite sidecar (`notes_fts`), the
// knowledge-base capability that distinguishes Cosheaf from a plain forge.
// Shared by the typed `/search` API route and the server-rendered search page
// so both run identical FTS + LIKE-fallback ranking.

import type Database from "better-sqlite3";

export type SnippetPart = { text: string; match: boolean };

export interface PageSearchResult {
  doc_id: string;
  path: string;
  title: string | null;
  snippet: SnippetPart[];
  rank: number;
}

// path → page title for the workspace's indexed `.md` pages (frontmatter title
// or body-extracted), so the file list can show titles instead of bare
// filenames (#132). Read from the indexed `doc_map` pages table (forgejo_id is
// the path); the sidecar mirrors `main` only, so callers pass it for the main
// view and fall back to the filename elsewhere.
export function workspacePageTitles(
  db: Database.Database,
  workspaceSlug: string,
): Map<string, string> {
  const rows = db
    .prepare("SELECT forgejo_id AS path, title FROM doc_map WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ path: string; title: string | null }>;
  const titles = new Map<string, string>();
  for (const row of rows) {
    const title = row.title?.trim();
    if (title) titles.set(row.path, title);
  }
  return titles;
}

// The repo chrome's Read-mode identity should follow the knowledge base title
// when the root README is indexed. Forgejo's repository description remains the
// fallback for repos that have no titled README in the sidecar yet.
export function workspaceReadmeTitle(
  db: Database.Database,
  workspaceSlug: string,
): string {
  const row = db
    .prepare(
      `SELECT title
         FROM doc_map
        WHERE workspace_slug = ? AND lower(forgejo_id) = 'readme.md'
        ORDER BY CASE forgejo_id WHEN 'README.md' THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(workspaceSlug) as { title: string | null } | undefined;
  return row?.title?.trim() ?? "";
}

// Short body excerpts per page, keyed by file path. Stored on doc_map so the
// repo landing page does not scan FTS bodies across the workspace.
export function workspacePageExcerpts(
  db: Database.Database,
  workspaceSlug: string,
  maxLength = 180,
): Map<string, string> {
  const rows = db
    .prepare("SELECT forgejo_id AS path, excerpt FROM doc_map WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ path: string; excerpt: string | null }>;
  const excerpts = new Map<string, string>();
  for (const row of rows) {
    const text = (row.excerpt ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    excerpts.set(row.path, text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text);
  }
  return excerpts;
}

export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface TagCount {
  tag: string;
  count: number;
  idf: number;
}

// Tag cloud for a workspace: each tag with its page count and IDF (rare tags
// score higher). IDF is computed here, not in SQL, to stay independent of
// SQLite's optional log() build. Shared by the tags API and the browse page.
export function workspaceTagCloud(db: Database.Database, workspaceSlug: string): TagCount[] {
  const rows = db
    .prepare("SELECT tag, COUNT(*) AS count FROM page_tags WHERE workspace_slug = ? GROUP BY tag")
    .all(workspaceSlug) as Array<{ tag: string; count: number }>;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM doc_map WHERE workspace_slug = ?").get(workspaceSlug) as { n: number }).n;
  return rows
    .map((r) => ({ tag: r.tag, count: r.count, idf: r.count > 0 && total > 0 ? Math.log(total / r.count) : 0 }))
    .sort((a, b) => b.idf - a.idf || a.tag.localeCompare(b.tag));
}

export interface TaggedPage {
  id: string;
  title: string | null;
  path: string;
  excerpt: string | null;
}

// Pages carrying a tag, ordered title-first. Shared by the tags API (which
// surfaces `excerpt`) and the browse page (which ignores it).
export function workspacePagesByTag(db: Database.Database, workspaceSlug: string, tag: string): TaggedPage[] {
  return db
    .prepare(
      "SELECT d.cosheaf_id AS id, d.title, d.forgejo_id AS path, d.excerpt FROM page_tags pt " +
        "JOIN doc_map d ON d.workspace_slug = pt.workspace_slug AND d.cosheaf_id = pt.cosheaf_id " +
        "WHERE pt.workspace_slug = ? AND pt.tag = ? ORDER BY d.title IS NULL, d.title, d.forgejo_id",
    )
    .all(workspaceSlug, tag) as TaggedPage[];
}

// Tags on one document (by repo-relative path), for the read-view chips.
export function documentTags(db: Database.Database, workspaceSlug: string, path: string): string[] {
  return (db
    .prepare(
      "SELECT pt.tag FROM page_tags pt JOIN doc_map d ON d.workspace_slug = pt.workspace_slug AND d.cosheaf_id = pt.cosheaf_id " +
        "WHERE d.workspace_slug = ? AND d.forgejo_id = ? ORDER BY pt.tag",
    )
    .all(workspaceSlug, path) as Array<{ tag: string }>).map((r) => r.tag);
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

const MAX_LIMIT = 50;

// Search a workspace's pages by free text. Returns ranked results (FTS bm25,
// falling back to a substring LIKE match when FTS finds nothing). Always scoped
// to `slug` — callers must pass the permission-validated workspace slug.
export function searchWorkspacePages(
  db: Database.Database,
  slug: string,
  q: string,
  limit = 25,
): PageSearchResult[] {
  const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(MAX_LIMIT, limit)) : 25;
  const terms = searchTerms(q);
  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) return [];
  type Row = { doc_id: string; path: string; title: string | null; body: string; rank: number };
  let rows = db
    .prepare(
      `SELECT cosheaf_id AS doc_id, path, title, body, bm25(notes_fts) AS rank
         FROM notes_fts
        WHERE workspace_slug = ? AND notes_fts MATCH ?
        ORDER BY rank LIMIT ?`,
    )
    .all(slug, ftsQuery, bounded) as Row[];
  if (rows.length === 0 && terms.length > 0) {
    const patterns = terms.map((t) => `%${likeEscape(t)}%`);
    const where = patterns
      .map(() => "(path LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const args = patterns.flatMap((p) => [p, p, p]);
    const fallback = db
      .prepare(
        `SELECT cosheaf_id AS doc_id, path, title, body
           FROM notes_fts
          WHERE workspace_slug = ? AND (${where})
          ORDER BY path LIMIT ?`,
      )
      .all(slug, ...args, bounded) as Array<Omit<Row, "rank">>;
    rows = fallback.map((r) => ({ ...r, rank: 0 }));
  }
  return rows.map((r) => ({
    doc_id: r.doc_id,
    path: r.path,
    title: r.title,
    snippet: plainSnippet(r, terms),
    rank: r.rank,
  }));
}
