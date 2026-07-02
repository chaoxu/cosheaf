export type LocalAnnotationKind = "comment" | "task";
export type LocalAnnotationStatus = "open" | "resolved";

export interface LocalAnnotationMessage {
  id: string;
  author: string;
  created_at: string;
  body: string;
}

export interface LocalAnnotation {
  id: string;
  kind: LocalAnnotationKind;
  status: LocalAnnotationStatus;
  path: string;
  anchor: string;
  created_at: string;
  updated_at: string;
  messages: LocalAnnotationMessage[];
}

export interface LocalAnnotationContext {
  line: number | null;
  excerpt: string;
  anchor_found: boolean;
}

export interface LocalAnnotationQueueItem extends LocalAnnotation {
  context: LocalAnnotationContext;
}
