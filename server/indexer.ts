// Sidecar maintenance. Forgejo is the source of truth; we mirror only what we
// need for fast read paths (FTS, backlinks, tags) and for keeping cosheaf doc
// ids stable across rebuilds.

import path from "node:path";
import type Database from "better-sqlite3";
import { extractTitle, generateDocId, parseDocument, serializeDocument } from "./frontmatter.js";

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

export function planIndexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const parsed = parseDocument(p.bodyText);
  const fmId = typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.length > 0
    ? parsed.frontmatter.id
    : null;

  const existingByPath = db
    .prepare(
      "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND doc_type = 'page' AND forgejo_id = ?",
    )
    .get(p.workspaceId, p.filePath) as { cosheaf_id: string } | undefined;

  let cosheafId = fmId ?? existingByPath?.cosheaf_id ?? generateDocId();

  const collision = db
    .prepare(
      "SELECT forgejo_id FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ? AND NOT (doc_type = 'page' AND forgejo_id = ?)",
    )
    .get(p.workspaceId, cosheafId, p.filePath) as { forgejo_id: string } | undefined;
  if (collision) cosheafId = generateDocId();

  const explicitTitle =
    typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.length > 0
      ? parsed.frontmatter.title
      : null;
  const title = explicitTitle ?? extractTitle(parsed.body);

  const commit = db.transaction(() => {
    const exists = db.prepare("SELECT 1 FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?").get(p.workspaceId, cosheafId);
    if (exists) {
      db.prepare("UPDATE doc_map SET forgejo_id = ?, title = ? WHERE workspace_id = ? AND cosheaf_id = ?")
        .run(p.filePath, title, p.workspaceId, cosheafId);
    } else {
      db.prepare(
        "INSERT INTO doc_map (cosheaf_id, workspace_id, doc_type, forgejo_kind, forgejo_id, title, created_at) VALUES (?, ?, 'page', 'file', ?, ?, ?)",
      ).run(cosheafId, p.workspaceId, p.filePath, title, Date.now());
    }
    db.prepare("DELETE FROM notes_fts WHERE workspace_id = ? AND cosheaf_id = ?").run(p.workspaceId, cosheafId);
    db.prepare(
      "INSERT INTO notes_fts (workspace_id, cosheaf_id, doc_type, path, title, body) VALUES (?, ?, 'page', ?, ?, ?)",
    ).run(p.workspaceId, cosheafId, p.filePath, title ?? "", parsed.body);
    db.prepare("DELETE FROM backlinks WHERE workspace_id = ? AND src_id = ?").run(p.workspaceId, cosheafId);
    for (const link of extractLinks(parsed.body)) {
      const targetId = resolveLinkTarget(db, p.workspaceId, p.filePath, link);
      db.prepare(
        "INSERT OR IGNORE INTO backlinks (workspace_id, src_id, src_path, target_id, target_label) VALUES (?, ?, ?, ?, ?)",
      ).run(p.workspaceId, cosheafId, p.filePath, targetId, link.raw);
    }
    db.prepare("DELETE FROM page_tags WHERE workspace_id = ? AND cosheaf_id = ?").run(p.workspaceId, cosheafId);
    const tags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [];
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0) {
        db.prepare(
          "INSERT OR IGNORE INTO page_tags (workspace_id, cosheaf_id, tag) VALUES (?, ?, ?)",
        ).run(p.workspaceId, cosheafId, t);
      }
    }
  });

  let rewritten: string | null = null;
  if (fmId !== cosheafId) {
    const newFm = { ...parsed.frontmatter, id: cosheafId };
    if (title) newFm.title = title;
    rewritten = serializeDocument(newFm, parsed.body);
  }

  return { cosheafId, title, rewrittenContent: rewritten, commit };
}

// Convenience for webhook-driven reindex where there's no Forgejo write to fail.
export function indexPage(db: Database.Database, p: PageIngest): IngestPlan {
  const plan = planIndexPage(db, p);
  plan.commit();
  return plan;
}

export function deletePage(db: Database.Database, workspaceId: number, filePath: string): void {
  const row = db
    .prepare(
      "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND doc_type = 'page' AND forgejo_id = ?",
    )
    .get(workspaceId, filePath) as { cosheaf_id: string } | undefined;
  if (!row) return;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM notes_fts WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, row.cosheaf_id);
    db.prepare("DELETE FROM backlinks WHERE workspace_id = ? AND src_id = ?").run(workspaceId, row.cosheaf_id);
    db.prepare("DELETE FROM page_tags WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, row.cosheaf_id);
    db.prepare("DELETE FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?").run(workspaceId, row.cosheaf_id);
  });
  tx();
}

// ----- link extraction -----

interface ExtractedLink {
  kind: "id" | "path";
  ref: string;
  raw: string;
}

const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;
const CROSSREF = /\[@([^\]\s]+)\]/g;
const MD_LINK = /\[([^\]\n]*)\]\(([^)\s]+\.md)\)/g;

function extractLinks(body: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  for (const m of body.matchAll(WIKI_LINK)) out.push({ kind: "id", ref: m[1].trim(), raw: m[0] });
  for (const m of body.matchAll(CROSSREF)) out.push({ kind: "id", ref: m[1].trim(), raw: m[0] });
  for (const m of body.matchAll(MD_LINK)) out.push({ kind: "path", ref: m[2], raw: m[0] });
  return out;
}

function resolveLinkTarget(
  db: Database.Database,
  workspaceId: number,
  srcPath: string,
  link: ExtractedLink,
): string | null {
  if (link.kind === "id") {
    const row = db
      .prepare("SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND cosheaf_id = ?")
      .get(workspaceId, link.ref) as { cosheaf_id: string } | undefined;
    return row?.cosheaf_id ?? link.ref;
  }
  const dir = path.posix.dirname(srcPath);
  const resolved = path.posix.normalize(path.posix.join(dir, link.ref));
  const row = db
    .prepare(
      "SELECT cosheaf_id FROM doc_map WHERE workspace_id = ? AND doc_type = 'page' AND forgejo_id = ?",
    )
    .get(workspaceId, resolved) as { cosheaf_id: string } | undefined;
  return row?.cosheaf_id ?? null;
}
