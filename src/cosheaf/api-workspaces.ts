import type { DocumentFormatId, Role, Workspace } from "./api-types";
import { jsonFetch } from "./api-core";

export const workspaceApi = {
  listWorkspaces: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/v1/workspaces").then((r) => r.workspaces),
  createWorkspace: (slug: string, name: string, defaultMdFormat?: DocumentFormatId) =>
    jsonFetch<Workspace>("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ slug, name, default_md_format: defaultMdFormat }),
    }),
  setWorkspaceMember: (slug: string, username: string, role: Role) =>
    jsonFetch<{ ok: true; username: string; role: Role }>(
      `/api/v1/workspaces/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    ),
};
