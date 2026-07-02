export const LOCAL_ANNOTATION_EVENT_TYPE = "local_annotation";

export type LocalAnnotationEventAction = "created" | "updated" | "message" | "deleted" | "moved";

export interface LocalAnnotationWorkbenchEvent {
  type: typeof LOCAL_ANNOTATION_EVENT_TYPE;
  action: LocalAnnotationEventAction;
  path: string;
  id?: string;
  previous_path?: string;
  count?: number;
  [key: string]: unknown;
}

export type LocalWorkbenchEvent = LocalAnnotationWorkbenchEvent;

export function isLocalAnnotationWorkbenchEvent(
  value: unknown,
  path?: string | null,
): value is LocalAnnotationWorkbenchEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type !== LOCAL_ANNOTATION_EVENT_TYPE) return false;
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
