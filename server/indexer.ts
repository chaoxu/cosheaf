import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { type Frontmatter, parseDocument, serializeDocument } from "./frontmatter.js";
import { reindexLinks } from "./links.js";

const DOCUMENT_TYPES = ["page", "review", "proposal"] as const;
const DOCUMENT_STATUSES = [
  "golden",
  "unreviewed",
  "rejected",
  "draft",
  "archived",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentMeta {
  id: string;
  type: DocumentType;
  status: DocumentStatus;
  title: string | null;
  target_id: string | null;
}

export class IdConflictError extends Error {
  constructor(
    public id: string,
    public existingPath: string,
  ) {
    super(`document id '${id}' already in use by '${existingPath}'`);
  }
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function generateId(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

function pickType(value: unknown): DocumentType {
  return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value)
    ? (value as DocumentType)
    : "page";
}

function pickStatus(value: unknown): DocumentStatus {
  return typeof value === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(value)
    ? (value as DocumentStatus)
    : "draft";
}

function extractTitle(body: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(body);
  return match ? match[1].trim() : null;
}

export interface IndexResult {
  meta: DocumentMeta;
  /** The canonical file content (frontmatter normalized + injected). */
  content: string;
  /** True if the canonical content differs from the input — caller should rewrite. */
  rewrote: boolean;
}

/**
 * Parse `inputContent`, fill in any missing frontmatter (auto-generate id, etc.),
 * and upsert the documents row. Caller is responsible for actually writing
 * `content` to disk.
 *
 * Throws `IdConflictError` if the frontmatter id is already taken by a
 * different path in this workspace.
 */
export function indexDocument(
  db: Database.Database,
  workspaceId: number,
  filePath: string,
  inputContent: string,
): IndexResult {
  const parsed = parseDocument(inputContent);
  const fm = parsed.frontmatter;

  const id = typeof fm.id === "string" && fm.id.length > 0 ? fm.id : generateId();
  const type = pickType(fm.type);
  const status = pickStatus(fm.status);
  const target = typeof fm.target === "string" && fm.target.length > 0 ? fm.target : null;
  const explicitTitle =
    typeof fm.title === "string" && fm.title.length > 0 ? fm.title : null;
  const title = explicitTitle ?? extractTitle(parsed.body);

  const meta: DocumentMeta = { id, type, status, title, target_id: target };

  const idCollision = db
    .prepare("SELECT path FROM documents WHERE workspace_id = ? AND id = ? AND path != ?")
    .get(workspaceId, id, filePath) as { path: string } | undefined;
  if (idCollision) throw new IdConflictError(id, idCollision.path);

  const upsert = db.transaction(() => {
    db.prepare(
      "DELETE FROM documents WHERE workspace_id = ? AND path = ? AND id != ?",
    ).run(workspaceId, filePath, id);
    db.prepare(
      `INSERT INTO documents (workspace_id, id, path, type, status, target_id, title, mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         path = excluded.path,
         type = excluded.type,
         status = excluded.status,
         target_id = excluded.target_id,
         title = excluded.title,
         mtime = excluded.mtime`,
    ).run(workspaceId, id, filePath, type, status, target, title, Date.now());
    reindexLinks(db, workspaceId, id, filePath, parsed.body);
    db.prepare(
      "DELETE FROM notes_fts WHERE workspace_id = ? AND doc_id = ?",
    ).run(workspaceId, id);
    db.prepare(
      "INSERT INTO notes_fts (workspace_id, doc_id, path, title, body) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, id, filePath, title ?? "", parsed.body);
  });
  upsert();

  const canonicalFm: Frontmatter = {
    id,
    title: title ?? undefined,
    type,
    status,
    ...(target ? { target } : {}),
  };
  const canonical = serializeDocument(canonicalFm, parsed.body);
  return { meta, content: canonical, rewrote: canonical !== inputContent };
}

export function deleteDocument(
  db: Database.Database,
  workspaceId: number,
  filePath: string,
): void {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT id FROM documents WHERE workspace_id = ? AND path = ?")
      .get(workspaceId, filePath) as { id: string } | undefined;
    if (row) {
      db.prepare("DELETE FROM notes_fts WHERE workspace_id = ? AND doc_id = ?").run(
        workspaceId,
        row.id,
      );
    }
    db.prepare("DELETE FROM documents WHERE workspace_id = ? AND path = ?").run(
      workspaceId,
      filePath,
    );
  });
  tx();
}
