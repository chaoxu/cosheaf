import type { DocumentFormatId, WorkspaceSettings } from "./api-types";
import { jsonFetch, workspaceApiPath as w } from "./api-core";

export const settingsApi = {
  getSettings: (slug: string) => jsonFetch<WorkspaceSettings>(`${w(slug)}/settings`),
  updateSettings: (slug: string, body: { min_approvals?: number; default_md_format?: DocumentFormatId }) =>
    jsonFetch<WorkspaceSettings>(`${w(slug)}/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
