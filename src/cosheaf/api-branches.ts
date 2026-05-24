import type { Branch } from "./api-types";
import { jsonFetch, workspaceApiPath as w } from "./api-core";

export const branchApi = {
  myBranches: (slug: string) =>
    jsonFetch<{ branches: Branch[] }>(`${w(slug)}/branches/mine`).then((r) => r.branches),
  createBranch: (slug: string, name: string) =>
    jsonFetch<{ name: string }>(`${w(slug)}/branches`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteBranch: (slug: string, name: string) =>
    jsonFetch<{ ok: true }>(`${w(slug)}/branches/${encodeURIComponent(name)}`, { method: "DELETE" }),
};
