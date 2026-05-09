import { promises as fs } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { writeAtomic } from "./atomic.js";
import { type Frontmatter, parseDocument, serializeDocument } from "./frontmatter.js";
import {
  type DocumentStatus,
  type DocumentMeta,
  indexDocument,
} from "./indexer.js";

export class WorkflowError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DocumentRow {
  id: string;
  path: string;
  type: "page" | "review" | "proposal";
  status: DocumentStatus;
  target_id: string | null;
  title: string | null;
}

export function getDocument(db: Database.Database, workspaceId: number, docId: string): DocumentRow {
  const row = db
    .prepare(
      "SELECT id, path, type, status, target_id, title FROM documents WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, docId) as DocumentRow | undefined;
  if (!row) throw new WorkflowError(404, `document '${docId}' not found`);
  return row;
}

export function getMinApprovals(db: Database.Database, workspaceId: number): number {
  const row = db
    .prepare("SELECT min_approvals FROM workspace_settings WHERE workspace_id = ?")
    .get(workspaceId) as { min_approvals: number } | undefined;
  return row?.min_approvals ?? 1;
}

export function setMinApprovals(db: Database.Database, workspaceId: number, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new WorkflowError(400, "min_approvals must be >= 1");
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, min_approvals) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET min_approvals = excluded.min_approvals`,
  ).run(workspaceId, n);
}

async function rewriteFileWithStatus(
  workspaceRoot: string,
  filePath: string,
  newStatus: DocumentStatus,
): Promise<string> {
  const full = path.join(workspaceRoot, filePath);
  const content = await fs.readFile(full, "utf8");
  const parsed = parseDocument(content);
  const fm: Frontmatter = { ...parsed.frontmatter, status: newStatus };
  return serializeDocument(fm, parsed.body);
}

async function applyStatus(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  doc: DocumentRow,
  newStatus: DocumentStatus,
): Promise<void> {
  const candidate = await rewriteFileWithStatus(workspaceRoot, doc.path, newStatus);
  const indexed = indexDocument(db, workspaceId, doc.path, candidate);
  await writeAtomic(workspaceId, workspaceRoot, doc.path, indexed.content);
}

export async function submitDocument(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  docId: string,
): Promise<{ status: DocumentStatus }> {
  const doc = getDocument(db, workspaceId, docId);
  if (doc.status !== "draft") throw new WorkflowError(409, `cannot submit (status=${doc.status})`);
  await applyStatus(db, workspaceId, workspaceRoot, doc, "unreviewed");
  return { status: "unreviewed" };
}

interface ApprovalCounts {
  approvals: number;
  rejections: number;
}

function getApprovalCounts(
  db: Database.Database,
  workspaceId: number,
  docId: string,
): ApprovalCounts {
  const row = db
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN decision = 'approve' THEN 1 ELSE 0 END) AS approvals, " +
        "SUM(CASE WHEN decision = 'reject' THEN 1 ELSE 0 END) AS rejections " +
        "FROM approvals WHERE workspace_id = ? AND document_id = ?",
    )
    .get(workspaceId, docId) as { approvals: number | null; rejections: number | null };
  return { approvals: row.approvals ?? 0, rejections: row.rejections ?? 0 };
}

async function promote(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  doc: DocumentRow,
): Promise<DocumentMeta> {
  if (doc.type === "proposal" && doc.target_id) {
    const target = getDocument(db, workspaceId, doc.target_id);
    const proposalParsed = parseDocument(
      await fs.readFile(path.join(workspaceRoot, doc.path), "utf8"),
    );
    const targetParsed = parseDocument(
      await fs.readFile(path.join(workspaceRoot, target.path), "utf8"),
    );
    const candidate = serializeDocument(
      { ...targetParsed.frontmatter, status: "golden" },
      proposalParsed.body,
    );
    const targetIndexed = indexDocument(db, workspaceId, target.path, candidate);
    await writeAtomic(workspaceId, workspaceRoot, target.path, targetIndexed.content);
    await applyStatus(db, workspaceId, workspaceRoot, doc, "archived");
    return targetIndexed.meta;
  }

  await applyStatus(db, workspaceId, workspaceRoot, doc, "golden");
  const updated = getDocument(db, workspaceId, doc.id);
  return {
    id: updated.id,
    type: updated.type,
    status: updated.status,
    title: updated.title,
    target_id: updated.target_id,
  };
}

export interface DecisionResult {
  decision: "approve" | "reject";
  approvals: number;
  rejections: number;
  doc_status: DocumentStatus;
  promoted_meta?: DocumentMeta;
}

export async function decideOnDocument(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  docId: string,
  verifierUserId: number,
  decision: "approve" | "reject",
  comment: string | null = null,
  reviewDocId: string | null = null,
): Promise<DecisionResult> {
  const doc = getDocument(db, workspaceId, docId);
  if (doc.status !== "unreviewed") {
    throw new WorkflowError(409, `cannot decide on document with status=${doc.status}`);
  }
  if (reviewDocId) {
    const review = getDocument(db, workspaceId, reviewDocId);
    if (review.type !== "review") {
      throw new WorkflowError(400, `document ${reviewDocId} is not a review`);
    }
    if (review.target_id !== docId) {
      throw new WorkflowError(400, `review ${reviewDocId} does not target ${docId}`);
    }
  }
  db.prepare(
    `INSERT INTO approvals (workspace_id, document_id, verifier_user_id, decision, comment, review_doc_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, document_id, verifier_user_id) DO UPDATE SET
       decision = excluded.decision,
       comment = excluded.comment,
       review_doc_id = excluded.review_doc_id,
       created_at = excluded.created_at`,
  ).run(workspaceId, docId, verifierUserId, decision, comment, reviewDocId, Date.now());

  const counts = getApprovalCounts(db, workspaceId, docId);

  if (decision === "reject") {
    await applyStatus(db, workspaceId, workspaceRoot, doc, "rejected");
    return { decision, ...counts, doc_status: "rejected" };
  }

  const min = getMinApprovals(db, workspaceId);
  if (counts.approvals >= min) {
    const promoted = await promote(db, workspaceId, workspaceRoot, doc);
    const after = getDocument(db, workspaceId, docId);
    return { decision, ...counts, doc_status: after.status, promoted_meta: promoted };
  }

  return { decision, ...counts, doc_status: "unreviewed" };
}

export interface QueueEntry {
  id: string;
  path: string;
  type: string;
  title: string | null;
  target_id: string | null;
  approvals: number;
  rejections: number;
}

export function getReviewQueue(db: Database.Database, workspaceId: number): QueueEntry[] {
  return db
    .prepare(
      `SELECT documents.id AS id,
              documents.path AS path,
              documents.type AS type,
              documents.title AS title,
              documents.target_id AS target_id,
              COALESCE(SUM(CASE WHEN approvals.decision = 'approve' THEN 1 ELSE 0 END), 0) AS approvals,
              COALESCE(SUM(CASE WHEN approvals.decision = 'reject' THEN 1 ELSE 0 END), 0) AS rejections
         FROM documents
         LEFT JOIN approvals
           ON approvals.workspace_id = documents.workspace_id
          AND approvals.document_id = documents.id
        WHERE documents.workspace_id = ? AND documents.status = 'unreviewed'
        GROUP BY documents.id
        ORDER BY documents.path`,
    )
    .all(workspaceId) as QueueEntry[];
}

export interface ApprovalRecord {
  verifier_user_id: number;
  username: string;
  decision: "approve" | "reject";
  comment: string | null;
  created_at: number;
  review_doc_id: string | null;
  review_path: string | null;
  review_title: string | null;
}

export function getApprovalsForDocument(
  db: Database.Database,
  workspaceId: number,
  docId: string,
): ApprovalRecord[] {
  return db
    .prepare(
      `SELECT approvals.verifier_user_id AS verifier_user_id,
              users.username AS username,
              approvals.decision AS decision,
              approvals.comment AS comment,
              approvals.created_at AS created_at,
              approvals.review_doc_id AS review_doc_id,
              review.path AS review_path,
              review.title AS review_title
         FROM approvals
         JOIN users ON users.id = approvals.verifier_user_id
         LEFT JOIN documents AS review
           ON review.workspace_id = approvals.workspace_id
          AND review.id = approvals.review_doc_id
        WHERE approvals.workspace_id = ? AND approvals.document_id = ?
        ORDER BY approvals.created_at DESC`,
    )
    .all(workspaceId, docId) as ApprovalRecord[];
}

export async function createProposal(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  targetId: string,
  body: string,
  authorUsername: string,
): Promise<{ proposalPath: string; meta: DocumentMeta }> {
  const target = getDocument(db, workspaceId, targetId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const proposalPath = `proposals/${target.id}-${stamp}-${authorUsername}.md`;
  const fm: Frontmatter = {
    type: "proposal",
    status: "draft",
    target: target.id,
    title: `Proposal for ${target.title ?? target.path}`,
  };
  const candidate = serializeDocument(fm, body);
  const indexed = indexDocument(db, workspaceId, proposalPath, candidate);
  await writeAtomic(workspaceId, workspaceRoot, proposalPath, indexed.content);
  return { proposalPath, meta: indexed.meta };
}

export async function createReview(
  db: Database.Database,
  workspaceId: number,
  workspaceRoot: string,
  targetId: string,
  body: string,
  authorUsername: string,
): Promise<{ reviewPath: string; meta: DocumentMeta }> {
  const target = getDocument(db, workspaceId, targetId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reviewPath = `reviews/${target.id}-${stamp}-${authorUsername}.md`;
  const fm: Frontmatter = {
    type: "review",
    status: "draft",
    target: target.id,
    title: `Review of ${target.title ?? target.path}`,
  };
  const candidate = serializeDocument(fm, body);
  const indexed = indexDocument(db, workspaceId, reviewPath, candidate);
  await writeAtomic(workspaceId, workspaceRoot, reviewPath, indexed.content);
  return { reviewPath, meta: indexed.meta };
}
