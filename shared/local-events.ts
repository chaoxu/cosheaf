export const LOCAL_FILE_EVENT_TYPE = "file_changed";
export const LOCAL_ANNOTATION_EVENT_TYPE = "annotations_changed";
export const LEGACY_LOCAL_ANNOTATION_EVENT_TYPE = "local_annotation";
export const LOCAL_GIT_EVENT_TYPE = "git_changed";
export const LOCAL_AGENT_ACTIVITY_EVENT_TYPE = "agent_activity_changed";

export type LocalFileEventAction = "changed" | "removed" | "moved";

export interface LocalFileWorkbenchEvent {
  type: typeof LOCAL_FILE_EVENT_TYPE;
  action: LocalFileEventAction;
  path: string;
  previous_path?: string;
  [key: string]: unknown;
}

export type LocalAnnotationEventAction = "created" | "updated" | "message" | "deleted" | "moved";

export interface LocalAnnotationWorkbenchEvent {
  type: typeof LOCAL_ANNOTATION_EVENT_TYPE | typeof LEGACY_LOCAL_ANNOTATION_EVENT_TYPE;
  action: LocalAnnotationEventAction;
  path: string;
  id?: string;
  previous_path?: string;
  count?: number;
  [key: string]: unknown;
}

export type LocalGitEventAction = "status_changed" | "committed" | "synced" | "pushed";

export interface LocalGitWorkbenchEvent {
  type: typeof LOCAL_GIT_EVENT_TYPE;
  action: LocalGitEventAction;
  sha?: string;
  paths?: string[];
  [key: string]: unknown;
}

export type LocalAgentActivityEventAction = "created" | "updated" | "completed" | "committed";

export interface LocalAgentActivityWorkbenchEvent {
  type: typeof LOCAL_AGENT_ACTIVITY_EVENT_TYPE;
  action: LocalAgentActivityEventAction;
  id: string;
  status: "active" | "waiting_for_review" | "done";
  touched_files: string[];
  [key: string]: unknown;
}

export type LocalWorkbenchEvent =
  | LocalFileWorkbenchEvent
  | LocalAnnotationWorkbenchEvent
  | LocalGitWorkbenchEvent
  | LocalAgentActivityWorkbenchEvent;

export function isLocalAnnotationWorkbenchEvent(
  value: unknown,
  path?: string | null,
): value is LocalAnnotationWorkbenchEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== LOCAL_ANNOTATION_EVENT_TYPE && event.type !== LEGACY_LOCAL_ANNOTATION_EVENT_TYPE) return false;
  if (
    event.action !== "created" &&
    event.action !== "updated" &&
    event.action !== "message" &&
    event.action !== "deleted" &&
    event.action !== "moved"
  ) return false;
  if (typeof event.path !== "string") return false;
  if (event.previous_path !== undefined && typeof event.previous_path !== "string") return false;
  if (!path) return true;
  return event.path === path || event.previous_path === path;
}
