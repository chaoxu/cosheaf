// Sidecar maintenance. Forgejo is the source of truth; we mirror only what we
// need for fast read paths (FTS, backlinks, tags) and for keeping cosheaf doc
// ids stable across rebuilds.

import path from "node:path";
import type Database from "better-sqlite3";
import { coflatMarkdownFormat, type DocumentLink } from "./document-format/coflat.js";
import { generateDocId } from "./ids.js";

export interface PageIngest {
  workspaceId: number;
  filePath: string;
  bodyText: string; // raw file content (frontmatter + body)
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
  const format = coflatMarkdownFormat;
  const parsed = format.parseDocument(p.bodyText);
  const fmId = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.length > 0
    ? parsed.frontmatter.id
    : null;

  const existingByPath = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND forgejo_id = ?",
  ).get(p.workspaceId, p.filePath) as { cosheaf_id: string } | undefined;

  let cosheafId = fmId ?? existingByPath?.cosheaf_id ?? generateDocId();

  const collision = prep(
    db,
    "SELECT forgejo_id FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ? AND forgejo_id != ?",
  ).get(p.workspaceId, cosheafId, p.filePath) as { forgejo_id: string } | undefined;
  if (collision) cosheafId = generateDocId();

  const explicitTitle =
    typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.length > 0
      ? parsed.frontmatter.title
      : null;
  const title = explicitTitle ?? format.extractTitle(parsed.body);

  const commit = db.transaction(() => {
    const stalePath = prep(
      db,
      "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND forgejo_id = ? AND cosheaf_id != ?",
    ).get(p.workspaceId, p.filePath, cosheafId) as { cosheaf_id: string } | undefined;
    if (stalePath) {
      deletePageRows(db, p.workspaceId, stalePath.cosheaf_id);
    }

    const exists = prep(db, "SELECT 1 FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?")
      .get(p.workspaceId, cosheafId);
    if (exists) {
      prep(db, "UPDATE doc_map SET forgejo_id = ?, title = ? WHERE workspace_id = ? AND cosheaf_id = ?")
        .run(p.filePath, title, p.workspaceId, cosheafId);
    } else {
      prep(
        db,
        "INSERT INTO doc_map (cosheaf_id, workspace_id, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(cosheafId, p.workspaceId, p.filePath, title, Date.now());
    }
    prep(db, "DELETE FROM notes_fts WHERE workspace_id = ? AND cosheaf_id = ?")
      .run(p.workspaceId, cosheafId);
    prep(
      db,
      "INSERT INTO notes_fts (workspace_id, cosheaf_id, path, title, body) VALUES (?, ?, ?, ?, ?)",
    ).run(p.workspaceId, cosheafId, p.filePath, title ?? "", parsed.body);
    prep(db, "DELETE FROM backlinks WHERE workspace_id = ? AND src_id = ?")
      .run(p.workspaceId, cosheafId);
    const insertBacklink = prep(
      db,
      "INSERT OR IGNORE INTO backlinks (workspace_id, src_id, src_path, target_id, target_label) VALUES (?, ?, ?, ?, ?)",
    );
    for (const link of format.extractLinks(parsed.body)) {
      const targetId = resolveLinkTarget(db, p.workspaceId, p.filePath, link);
      insertBacklink.run(p.workspaceId, cosheafId, p.filePath, targetId, link.raw);
    }
    prep(db, "DELETE FROM page_tags WHERE workspace_id = ? AND cosheaf_id = ?")
      .run(p.workspaceId, cosheafId);
    const tags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
    const insertTag = prep(
      db,
      "INSERT OR IGNORE INTO page_tags (workspace_id, cosheaf_id, tag) VALUES (?, ?, ?)",
    );
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0) {
        insertTag.run(p.workspaceId, cosheafId, t);
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

// Convenience for webhook-driven reindex where there's no Forgejo write to fail.
export function indexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const plan = planIndexPage(db, p);
  plan.commit();
  return plan;
}

function deletePageRows(db: Database.Database, workspaceId: number, cosheafId: string): void {
  prep(db, "DELETE FROM notes_fts WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, cosheafId);
  prep(db, "DELETE FROM backlinks WHERE workspace_id = ? AND src_id = ?").run(workspaceId, cosheafId);
  prep(db, "DELETE FROM page_tags WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, cosheafId);
  prep(db, "DELETE FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, cosheafId);
}

export function deletePage(db: Database.Database, workspaceId: number, filePath: string): void {
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND forgejo_id = ?",
  ).get(workspaceId, filePath) as { cosheaf_id: string } | undefined;
  if (!row) return;
  db.transaction(() => deletePageRows(db, workspaceId, row.cosheaf_id))();
}

function resolveLinkTarget(
  db: Database.Database,
  workspaceId: number,
  srcPath: string,
  link: DocumentLink,
): string | null {
  if (link.kind === "id") {
    const row = prep(db, "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?")
      .get(workspaceId, link.ref) as { cosheaf_id: string } | undefined;
    return row?.cosheaf_id ?? link.ref;
  }
  const [linkPath] = link.ref.split("#", 1);
  if (!linkPath) return null;
  const dir = path.posix.dirname(srcPath);
  const resolved = path.posix.normalize(path.posix.join(dir, linkPath));
  const row = prep(
    db,
    "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND forgejo_id = ?",
  ).get(workspaceId, resolved) as { cosheaf_id: string } | undefined;
  return row?.cosheaf_id ?? null;
}
