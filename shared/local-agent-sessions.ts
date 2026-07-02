export type LocalAgentSessionStatus = "active" | "waiting_for_review" | "done";

export interface LocalAgentSessionMessage {
  id: string;
  author: string;
  created_at: string;
  body: string;
}

export interface LocalAgentSession {
  id: string;
  status: LocalAgentSessionStatus;
  title: string;
  started_at: string;
  updated_at: string;
  baseline_head_sha: string | null;
  touched_files: string[];
  linked_annotations: string[];
  summary: string;
  messages: LocalAgentSessionMessage[];
}
