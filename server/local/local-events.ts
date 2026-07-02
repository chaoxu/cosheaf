import type { Context } from "hono";
import {
  LOCAL_AGENT_ACTIVITY_EVENT_TYPE,
  LOCAL_ANNOTATION_EVENT_TYPE,
  LOCAL_FILE_EVENT_TYPE,
  LOCAL_GIT_EVENT_TYPE,
  type LocalAgentActivityEventAction,
  type LocalAnnotationEventAction,
  type LocalFileEventAction,
  type LocalGitEventAction,
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

interface LocalFileEventInput {
  action: LocalFileEventAction;
  path: string;
  previous_path?: string;
}

interface LocalGitEventInput {
  action: LocalGitEventAction;
  sha?: string;
  paths?: string[];
}

interface LocalAgentActivityEventInput {
  action: LocalAgentActivityEventAction;
  id: string;
  status: "active" | "waiting_for_review" | "done";
  touched_files: string[];
}

export function publishLocalWorkbenchEvent(
  c: Context<AppEnv>,
  target: WorkspaceEntry | string,
  event: LocalWorkbenchEvent,
): void {
  const slug = typeof target === "string" ? target : target.slug;
  c.get("sse").publish(slug, event);
}

export function publishLocalFileEvent(
  c: Context<AppEnv>,
  target: WorkspaceEntry | string,
  event: LocalFileEventInput,
): void {
  publishLocalWorkbenchEvent(c, target, { ...event, type: LOCAL_FILE_EVENT_TYPE });
}

export function publishLocalFileMutationEvents(
  c: Context<AppEnv>,
  target: WorkspaceEntry | string,
  event: LocalFileEventInput,
): void {
  const slug = typeof target === "string" ? target : target.slug;
  const paths = event.action === "moved" && event.previous_path ? [event.previous_path, event.path] : [event.path];
  publishLocalFileEvent(c, slug, event);
  publishLocalGitEvent(c, slug, { action: "status_changed", paths });
  if (event.action === "moved" && event.previous_path) {
    c.get("sse").publish(slug, { type: "change", path: event.previous_path });
  }
  c.get("sse").publish(slug, { type: "change", path: event.path });
}

export function publishLocalAnnotationEvent(
  c: Context<AppEnv>,
  entry: WorkspaceEntry,
  event: LocalAnnotationEventInput,
): void {
  publishLocalWorkbenchEvent(c, entry, { ...event, type: LOCAL_ANNOTATION_EVENT_TYPE });
}

export function publishLocalGitEvent(
  c: Context<AppEnv>,
  target: WorkspaceEntry | string,
  event: LocalGitEventInput,
): void {
  publishLocalWorkbenchEvent(c, target, { ...event, type: LOCAL_GIT_EVENT_TYPE });
}

export function publishLocalAgentActivityEvent(
  c: Context<AppEnv>,
  target: WorkspaceEntry | string,
  event: LocalAgentActivityEventInput,
): void {
  publishLocalWorkbenchEvent(c, target, { ...event, type: LOCAL_AGENT_ACTIVITY_EVENT_TYPE });
}
