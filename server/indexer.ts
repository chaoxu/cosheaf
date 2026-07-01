// Sidecar maintenance. Forgejo is the source of truth; we mirror only what we
// need for fast read paths (FTS, backlinks, tags) and for keeping cosheaf doc
// ids stable across rebuilds.

import { resolveMarkdownReferencePathFromDocument } from "@chaoxu/coflat/parse";
import type Database from "better-sqlite3";
import { extractBibTeXCitationKeys } from "./citations.js";
import type { DocumentLink, ParsedDocument } from "./document-format/types.js";
import { getDocumentFormat } from "./format-registry.js";
import { generateDocId } from "./ids.js";

export interface PageIngest {
  workspaceSlug: string;
  filePath: string;
  bodyText: string; // raw file content (frontmatter + body)
  formatId?: string;
  // Existing path being canonically replaced by this write. Used by typed
  // branch-only renames so a stable page id can move paths without being treated
  // as a duplicate of itself.
  replacePath?: string;
}

export interface IngestPlan {
  cosheafId: string;
  title: string | null;
  rewrittenContent: string | null; // non-null if frontmatter needed an injected id
  commit: () => void; // commits sidecar transaction; call only after the canonical write succeeds
}

// Prepared-statement cache. `better-sqlite3` does not cache by SQL string, so
// without this we'd re-parse the same ~10 statements on every indexed page
// (hot during bulk reindex and webhook bursts).
const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function prep(db: Database.Database, sql: string): Database.Statement {
  let bySql = stmtCache.get(db);
  if (!bySql) {
    bySql = new Map();
    stmtCache.set(db, bySql);
  }
  let s = bySql.get(sql);
  if (!s) {
    s = db.prepare(sql);
    bySql.set(sql, s);
  }
  return s;
}

export function planIndexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const format = getDocumentFormat(p.formatId);
  const parsed = format.parseDocument(p.bodyText);
  const fmId = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.length > 0
    ? parsed.frontmatter.id
    : null;

  const existingByPath = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(p.workspaceSlug, p.filePath) as { cosheaf_id: string } | undefined;

  let cosheafId = fmId ?? existingByPath?.cosheaf_id ?? generateDocId();

  const collision = prep(
    db,
    `SELECT forgejo_id FROM doc_map
      WHERE workspace_slug = ?
        AND cosheaf_id = ?
        AND forgejo_id != ?
        AND (? IS NULL OR forgejo_id != ?)`,
  ).get(p.workspaceSlug, cosheafId, p.filePath, p.replacePath ?? null, p.replacePath ?? null) as { forgejo_id: string } | undefined;
  if (collision) {
    // A frontmatter id duplicated across files collides. Prefer this path's
    // already-assigned id (stable across reindexes) so we don't churn a fresh
    // random id every run — mint one only when there's no prior id, or the
    // prior id is itself the colliding value.
    cosheafId =
      existingByPath && existingByPath.cosheaf_id !== cosheafId ? existingByPath.cosheaf_id : generateDocId();
  }

  const explicitTitle =
    typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.length > 0
      ? parsed.frontmatter.title
      : null;
  const title = explicitTitle ?? format.extractTitle(parsed.body);

  const commit = db.transaction(() => {
    const stalePath = prep(
      db,
      "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ? AND cosheaf_id != ?",
    ).get(p.workspaceSlug, p.filePath, cosheafId) as { cosheaf_id: string } | undefined;
    if (stalePath) {
      deletePageRows(db, p.workspaceSlug, stalePath.cosheaf_id);
    }

    const exists = prep(db, "SELECT 1 FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
      .get(p.workspaceSlug, cosheafId);
    if (exists) {
      prep(db, "UPDATE doc_map SET forgejo_id = ?, title = ? WHERE workspace_slug = ? AND cosheaf_id = ?")
        .run(p.filePath, title, p.workspaceSlug, cosheafId);
    } else {
      prep(
        db,
        "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(cosheafId, p.workspaceSlug, p.filePath, title, Date.now());
    }
    prep(db, "DELETE FROM notes_fts WHERE workspace_slug = ? AND cosheaf_id = ?")
      .run(p.workspaceSlug, cosheafId);
    prep(
      db,
      "INSERT INTO notes_fts (workspace_slug, cosheaf_id, path, title, body) VALUES (?, ?, ?, ?, ?)",
    ).run(p.workspaceSlug, cosheafId, p.filePath, title ?? "", parsed.body);
    prep(db, "DELETE FROM backlinks WHERE workspace_slug = ? AND src_id = ?")
      .run(p.workspaceSlug, cosheafId);
    prep(db, "DELETE FROM xref_targets WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    prep(db, "DELETE FROM xref_target_duplicates WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    const insertXrefTarget = prep(
      db,
      "INSERT OR IGNORE INTO xref_targets (workspace_slug, target_id, source_path, kind, display_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const xrefTargets = format.extractXrefTargets?.(p.bodyText) ?? [];
    const duplicateCounts = new Map<string, number>();
    for (const target of xrefTargets) duplicateCounts.set(target.id, (duplicateCounts.get(target.id) ?? 0) + 1);
    const insertXrefDuplicate = prep(
      db,
      "INSERT OR REPLACE INTO xref_target_duplicates (workspace_slug, target_id, source_path, count) VALUES (?, ?, ?, ?)",
    );
    for (const [targetId, count] of duplicateCounts) {
      if (count > 1) insertXrefDuplicate.run(p.workspaceSlug, targetId, p.filePath, count);
    }
    for (const target of xrefTargets) {
      insertXrefTarget.run(
        p.workspaceSlug,
        target.id,
        p.filePath,
        target.kind,
        target.label,
        target.line,
      );
    }
    const insertBacklink = prep(
      db,
      "INSERT OR IGNORE INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const link of format.extractLinks(p.bodyText)) {
      const targetId = resolveLinkTarget(db, p.workspaceSlug, p.filePath, link);
      insertBacklink.run(
        p.workspaceSlug,
        cosheafId,
        p.filePath,
        targetId,
        link.raw,
        link.line ?? lineFromOffset(p.bodyText, link.from),
      );
    }
    prep(db, "DELETE FROM page_tags WHERE workspace_slug = ? AND cosheaf_id = ?")
      .run(p.workspaceSlug, cosheafId);
    const tags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
    const insertTag = prep(
      db,
      "INSERT OR IGNORE INTO page_tags (workspace_slug, cosheaf_id, tag) VALUES (?, ?, ?)",
    );
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0) {
        insertTag.run(p.workspaceSlug, cosheafId, t);
      }
    }
  });

  let rewritten: string | null = null;
  if (fmId !== cosheafId && !hasUnparsedDelimitedFrontmatter(p.bodyText, parsed.hadFrontmatter)) {
    rewritten = rewriteFrontmatterIdInPlace(p.bodyText, parsed, cosheafId);
    if (rewritten === null) {
      const newFm = { ...parsed.frontmatter, id: cosheafId };
      if (title) newFm.title = title;
      rewritten = format.serializeDocument(newFm, parsed.body);
    }
  }

  return { cosheafId, title, rewrittenContent: rewritten, commit };
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function hasUnparsedDelimitedFrontmatter(source: string, hadParsedFrontmatter: boolean): boolean {
  if (hadParsedFrontmatter) return false;
  const firstEnd = frontmatterFenceLineEnd(source, 0);
  if (firstEnd === null) return false;
  let lineStart = firstEnd;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") return true;
    lineStart = lineEnd === -1 ? source.length : lineEnd + 1;
  }
  return false;
}

function rewriteFrontmatterIdInPlace(source: string, parsed: ParsedDocument, cosheafId: string): string | null {
  if (!parsed.hadFrontmatter) return null;
  const openingEnd = frontmatterFenceLineEnd(source, 0);
  if (openingEnd === null) return null;
  const closing = frontmatterClosingFence(source, openingEnd);
  if (!closing) return null;
  const lineEnding = source.slice(Math.max(0, openingEnd - 2), openingEnd) === "\r\n" ? "\r\n" : "\n";
  const idLine = findPlainTopLevelIdLine(source, openingEnd, closing.yamlEnd);
  if (idLine) {
    return `${source.slice(0, idLine.from)}id: ${cosheafId}${source.slice(idLine.to)}`;
  }
  return `${source.slice(0, openingEnd)}id: ${cosheafId}${lineEnding}${source.slice(openingEnd)}`;
}

function frontmatterClosingFence(source: string, bodyStart: number): { yamlEnd: number; bodyStart: number } | null {
  let lineStart = bodyStart;
  while (lineStart <= source.length) {
    const lineEnd = source.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(lineStart, end);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      return {
        yamlEnd: rawLine.endsWith("\r") ? end - 1 : end,
        bodyStart: lineEnd === -1 ? source.length : lineEnd + 1,
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function findPlainTopLevelIdLine(source: string, start: number, end: number): { from: number; to: number } | null {
  let lineStart = start;
  while (lineStart <= end) {
    const lineEnd = source.indexOf("\n", lineStart);
    const rawEnd = lineEnd === -1 ? source.length : lineEnd;
    const boundedRawEnd = Math.min(rawEnd, end);
    const textEnd = source[boundedRawEnd - 1] === "\r" ? boundedRawEnd - 1 : boundedRawEnd;
    const line = source.slice(lineStart, textEnd);
    if (line.startsWith("id:") || line.startsWith("id :")) {
      return { from: lineStart, to: textEnd };
    }
    if (lineEnd === -1 || lineEnd >= end) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function frontmatterFenceLineEnd(source: string, offset: number): number | null {
  if (!source.startsWith("---", offset)) return null;
  const afterFence = offset + 3;
  const next = source[afterFence];
  if (next === "\n") return afterFence + 1;
  if (next === "\r" && source[afterFence + 1] === "\n") return afterFence + 2;
  return afterFence === source.length ? afterFence : null;
}

// Convenience for webhook-driven reindex where there's no Forgejo write to fail.
export function indexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const plan = planIndexPage(db, p);
  plan.commit();
  return plan;
}

function deletePageRows(db: Database.Database, workspaceSlug: string, cosheafId: string): void {
  prep(db, "DELETE FROM notes_fts WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
  prep(db, "DELETE FROM backlinks WHERE workspace_slug = ? AND src_id = ?").run(workspaceSlug, cosheafId);
  prep(db, "DELETE FROM page_tags WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
  prep(db, "DELETE FROM xref_targets WHERE workspace_slug = ? AND source_path IN (SELECT forgejo_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?)")
    .run(workspaceSlug, workspaceSlug, cosheafId);
  prep(db, "DELETE FROM xref_target_duplicates WHERE workspace_slug = ? AND source_path IN (SELECT forgejo_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?)")
    .run(workspaceSlug, workspaceSlug, cosheafId);
  prep(db, "DELETE FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?").run(workspaceSlug, cosheafId);
}

export function deletePage(db: Database.Database, workspaceSlug: string, filePath: string): void {
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(workspaceSlug, filePath) as { cosheaf_id: string } | undefined;
  if (!row) return;
  db.transaction(() => deletePageRows(db, workspaceSlug, row.cosheaf_id))();
}

// Local Workbench keeps the sidecar live itself: the working tree is canonical
// and there is no merge webhook, so a write/delete must be indexed immediately.
// Both are a no-op in hosted mode, where webhooks/reindex reconcile `main`.
// Centralized here so every write/delete route doesn't repeat the rationale.
export function indexLocalWrite(
  local: boolean,
  db: Database.Database,
  workspaceSlug: string,
  plan: IngestPlan | null,
  renamedFrom?: string,
): void {
  if (!local) return;
  plan?.commit();
  if (renamedFrom) deletePage(db, workspaceSlug, renamedFrom);
}

export function indexLocalDelete(local: boolean, db: Database.Database, workspaceSlug: string, filePath: string): void {
  if (local) deletePage(db, workspaceSlug, filePath);
}

export function indexCitationFile(
  db: Database.Database,
  p: { workspaceSlug: string; filePath: string; bodyText: string },
): number {
  const keys = extractBibTeXCitationKeys(p.bodyText);
  db.transaction(() => {
    prep(db, "DELETE FROM citation_targets WHERE workspace_slug = ? AND source_path = ?")
      .run(p.workspaceSlug, p.filePath);
    const insertCitation = prep(
      db,
      "INSERT OR IGNORE INTO citation_targets (workspace_slug, target_id, source_path) VALUES (?, ?, ?)",
    );
    for (const key of keys) insertCitation.run(p.workspaceSlug, key, p.filePath);
  })();
  return keys.length;
}

export function deleteCitationFile(db: Database.Database, workspaceSlug: string, filePath: string): void {
  prep(db, "DELETE FROM citation_targets WHERE workspace_slug = ? AND source_path = ?")
    .run(workspaceSlug, filePath);
}

function resolveLinkTarget(
  db: Database.Database,
  workspaceSlug: string,
  srcPath: string,
  link: DocumentLink,
): string | null {
  if (link.kind === "id") {
    const row = prep(db, "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ?")
      .get(workspaceSlug, link.ref) as { cosheaf_id: string } | undefined;
    if (row) return row.cosheaf_id;
    const target = prep(db, "SELECT target_id FROM xref_targets WHERE workspace_slug = ? AND target_id = ? LIMIT 1")
      .get(workspaceSlug, link.ref) as { target_id: string } | undefined;
    const duplicate = prep(db, "SELECT 1 FROM xref_target_duplicates WHERE workspace_slug = ? AND target_id = ? LIMIT 1")
      .get(workspaceSlug, link.ref);
    if (duplicate) return link.ref;
    return target?.target_id ?? link.ref;
  }
  const [linkPath] = link.ref.split("#", 1);
  if (!linkPath) return null;
  const resolved = resolveMarkdownReferencePathFromDocument(srcPath, linkPath);
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(workspaceSlug, resolved) as { cosheaf_id: string } | undefined;
  return row?.cosheaf_id ?? null;
}
