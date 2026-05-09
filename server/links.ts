import path from "node:path";
import type Database from "better-sqlite3";

export interface RawLink {
  kind: "id" | "path";
  ref: string;
  raw: string;
}

const WIKI_LINK = /\[\[([^\]\n]+)\]\]/g;
const CROSSREF = /\[@([^\]\s]+)\]/g;
const MD_LINK = /\[([^\]\n]*)\]\(([^)\s]+\.md)\)/g;

export function extractRawLinks(body: string): RawLink[] {
  const out: RawLink[] = [];
  for (const m of body.matchAll(WIKI_LINK)) {
    out.push({ kind: "id", ref: m[1].trim(), raw: m[0] });
  }
  for (const m of body.matchAll(CROSSREF)) {
    out.push({ kind: "id", ref: m[1].trim(), raw: m[0] });
  }
  for (const m of body.matchAll(MD_LINK)) {
    out.push({ kind: "path", ref: m[2], raw: m[0] });
  }
  return out;
}

function resolvePath(srcPath: string, ref: string): string {
  const dir = path.posix.dirname(srcPath);
  return path.posix.normalize(path.posix.join(dir, ref));
}

export function reindexLinks(
  db: Database.Database,
  workspaceId: number,
  srcId: string,
  srcPath: string,
  body: string,
): void {
  db.prepare("DELETE FROM links WHERE workspace_id = ? AND src_id = ?").run(workspaceId, srcId);
  const raws = extractRawLinks(body);
  if (raws.length === 0) return;
  const insert = db.prepare(
    "INSERT INTO links (workspace_id, src_id, target_id, target_label) VALUES (?, ?, ?, ?)",
  );
  const lookupByPath = db.prepare(
    "SELECT id FROM documents WHERE workspace_id = ? AND path = ?",
  );
  const lookupById = db.prepare(
    "SELECT id FROM documents WHERE workspace_id = ? AND id = ?",
  );
  for (const link of raws) {
    let targetId: string | null = null;
    if (link.kind === "id") {
      const row = lookupById.get(workspaceId, link.ref) as { id: string } | undefined;
      targetId = row ? row.id : link.ref; // keep the ref so backlinks resolve when target appears
    } else {
      const resolved = resolvePath(srcPath, link.ref);
      const row = lookupByPath.get(workspaceId, resolved) as { id: string } | undefined;
      targetId = row?.id ?? null;
    }
    insert.run(workspaceId, srcId, targetId, link.raw);
  }
}

export interface Backlink {
  src_id: string;
  src_path: string;
  src_title: string | null;
  target_label: string;
}

export function getBacklinks(
  db: Database.Database,
  workspaceId: number,
  targetId: string,
): Backlink[] {
  return db
    .prepare(
      `SELECT documents.id AS src_id,
              documents.path AS src_path,
              documents.title AS src_title,
              links.target_label AS target_label
         FROM links
         JOIN documents
           ON documents.workspace_id = links.workspace_id
          AND documents.id = links.src_id
        WHERE links.workspace_id = ? AND links.target_id = ?
        ORDER BY documents.path`,
    )
    .all(workspaceId, targetId) as Backlink[];
}
