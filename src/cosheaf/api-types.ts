import type { CommentSide, LineComment } from "../../shared/comments";
import type { DocumentFormatId } from "../../shared/document-format";
import type { Role } from "../../shared/roles";
import type { PrFile, PrFiles, PrMeta, PrState } from "../../shared/review";
import type { WorkspaceValidation } from "../../shared/validation";

export type Decision = "approve" | "request_changes" | "comment";
export type { CommentSide, DocumentFormatId, LineComment, PrFile, PrFiles, PrMeta, PrState, Role, WorkspaceValidation };

export interface User {
  username: string;
}

export interface Workspace {
  slug: string;
  name: string;
  role: Role;
  default_md_format: DocumentFormatId;
}

export interface WorkspaceSettings {
  min_approvals: number;
  default_md_format: DocumentFormatId;
  formats: Array<{ id: DocumentFormatId; displayName: string }>;
}

export interface DocumentMeta {
  id: string;
  title: string | null;
}

export interface FileEntry {
  path: string;
  size: number;
  doc?: DocumentMeta;
}

export interface NoteContent {
  content: string;
}

export interface Branch {
  name: string;
  commit_sha: string | null;
  updated_at: number;
}

export type OpenPull = PrMeta;
export type PullReviewEntry = PrMeta & { approvals: number; rejections: number };

export interface ApprovalRecord {
  id: number;
  username: string;
  decision: Decision;
  comment: string | null;
  created_at: number;
}

export interface Backlink {
  src_id: string;
  src_path: string;
  src_title: string | null;
  target_label: string;
}

export interface SearchResult {
  doc_id: string;
  path: string;
  title: string | null;
  type: string;
  status: string;
  target_id: string | null;
  snippet: Array<{ text: string; match: boolean }>;
  rank: number;
}

export interface DecisionResult {
  ok: true;
  approvals: number;
  rejections: number;
}
