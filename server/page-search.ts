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

// Short body excerpts per page from the FTS sidecar, keyed by file path — used by
// the /files landing index (#136) to show a one-line description under each page
// title, so the main panel reads richer than the nav tree. Whitespace-collapsed
// and clipped; pages with empty bodies are omitted.
export function workspacePageExcerpts(
  db: Database.Database,
  workspaceSlug: string,
  maxLength = 180,
): Map<string, string> {
  const rows = db
    .prepare("SELECT path, body FROM notes_fts WHERE workspace_slug = ?")
    .all(workspaceSlug) as Array<{ path: string; body: string | null }>;
  const excerpts = new Map<string, string>();
  for (const row of rows) {
    const text = (row.body ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    excerpts.set(row.path, text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text);
  }
  return excerpts;
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
