// Sidecar maintenance. Forgejo is the source of truth; we mirror only what we
// need for fast read paths (FTS, backlinks, tags) and for keeping cosheaf doc
// ids stable across rebuilds.

import path from "node:path";
import type Database from "better-sqlite3";
import type { DocumentLink } from "./document-format/types.js";
import { getDocumentFormat } from "./format-registry.js";
import { generateDocId } from "./ids.js";

export interface PageIngest {
  workspaceSlug: string;
  filePath: string;
  bodyText: string; // raw file content (frontmatter + body)
  formatId?: string;
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
    "SELECT forgejo_id FROM doc_map WHERE workspace_slug = ? AND cosheaf_id = ? AND forgejo_id != ?",
  ).get(p.workspaceSlug, cosheafId, p.filePath) as { forgejo_id: string } | undefined;
  if (collision) cosheafId = generateDocId();

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
    const insertXrefTarget = prep(
      db,
      "INSERT OR IGNORE INTO xref_targets (workspace_slug, target_id, source_path, kind, display_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const target of format.extractXrefTargets?.(parsed.body) ?? []) {
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
    const bodyStart = p.bodyText.length - parsed.body.length;
    for (const link of format.extractLinks(parsed.body)) {
      const targetId = resolveLinkTarget(db, p.workspaceSlug, p.filePath, link);
      insertBacklink.run(
        p.workspaceSlug,
        cosheafId,
        p.filePath,
        targetId,
        link.raw,
        lineFromOffset(p.bodyText, bodyStart + link.from),
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
  if (fmId !== cosheafId) {
    const newFm = { ...parsed.frontmatter, id: cosheafId };
    if (title) newFm.title = title;
    rewritten = format.serializeDocument(newFm, parsed.body);
  }

  return { cosheafId, title, rewrittenContent: rewritten, commit };
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
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
    return target?.target_id ?? link.ref;
  }
  const [linkPath] = link.ref.split("#", 1);
  if (!linkPath) return null;
  const dir = path.posix.dirname(srcPath);
  const resolved = path.posix.normalize(path.posix.join(dir, linkPath));
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_slug = ? AND forgejo_id = ?",
  ).get(workspaceSlug, resolved) as { cosheaf_id: string } | undefined;
  return row?.cosheaf_id ?? null;
}
