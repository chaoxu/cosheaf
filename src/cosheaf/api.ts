import type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  NotificationRow,
  TimelineEvent,
} from "../../shared/issues";
import { branchApi } from "./api-branches";
import { ApiError, getStoredPat, jsonFetch, setStoredPat } from "./api-core";
import { fileApi } from "./api-files";
import { issueApi } from "./api-issues";
import { notificationApi } from "./api-notifications";
import { pullApi } from "./api-pulls";
import { settingsApi } from "./api-settings";
import type { User } from "./api-types";
import { workspaceApi } from "./api-workspaces";

export { ApiError, getStoredPat, setStoredPat };
export type {
  ApprovalRecord,
  Backlink,
  Branch,
  CommentSide,
  Decision,
  DecisionResult,
  DocumentMeta,
  FileEntry,
  LineComment,
  NoteContent,
  OpenPull,
  PrFile,
  PrFiles,
  PrMeta,
  PrState,
  PullReviewEntry,
  Role,
  SearchResult,
  User,
  Workspace,
  WorkspaceSettings,
  WorkspaceValidation,
} from "./api-types";
export type {
  ActivityRow,
  DependencyRow,
  IssueComment,
  IssueDetail,
  IssueRow,
  Label,
  Milestone,
  NotificationRow,
  TimelineEvent,
};

export const api = {
  me: () => jsonFetch<{ user: User | null }>("/api/v1/me"),
  login: (username: string, password: string) =>
    jsonFetch<{ username: string; pat: string }>("/api/v1/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }).then((r) => {
      setStoredPat(r.pat);
      return { username: r.username } as User;
    }),
  logout: () => {
    // Best-effort; the server response is fire-and-forget. Clearing the
    // local PAT is what actually logs the user out.
    const p = jsonFetch<{ ok: true }>("/api/v1/logout", { method: "POST" }).catch(() => undefined);
    setStoredPat(null);
    return p.then(() => ({ ok: true as const }));
  },

  ...workspaceApi,
  ...fileApi,
  ...branchApi,
  ...pullApi,
  ...settingsApi,
  ...issueApi,
  ...notificationApi,
};
