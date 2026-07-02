import type { Context } from "hono";
import {
  LOCAL_ANNOTATION_EVENT_TYPE,
  type LocalAnnotationEventAction,
  type LocalWorkbenchEvent,
} from "../../shared/local-events.js";
import type { AppEnv } from "../types.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

interface LocalAnnotationEventInput {
  action: LocalAnnotationEventAction;
  path: string;
  id?: string;
  previous_path?: string;
  count?: number;
}

export function publishLocalWorkbenchEvent(
  c: Context<AppEnv>,
  entry: WorkspaceEntry,
  event: LocalWorkbenchEvent,
): void {
  c.get("sse").publish(entry.slug, event);
}

export function publishLocalAnnotationEvent(
  c: Context<AppEnv>,
  entry: WorkspaceEntry,
  event: LocalAnnotationEventInput,
): void {
  publishLocalWorkbenchEvent(c, entry, { ...event, type: LOCAL_ANNOTATION_EVENT_TYPE });
}
