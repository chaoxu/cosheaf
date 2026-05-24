import type { Backlink, DocumentMeta, FileEntry, NoteContent, SearchResult } from "./api-types";
import type { WorkspaceValidation } from "../../shared/validation";
import { ApiError, getStoredPat, jsonFetch, queryString as qs, workspaceApiPath as w } from "./api-core";

export const fileApi = {
  tree: (slug: string, branch?: string) =>
    jsonFetch<{ files: FileEntry[] }>(`${w(slug)}/tree${qs({ branch })}`).then((r) => r.files),

  getFile: (slug: string, path: string, branch?: string) =>
    jsonFetch<NoteContent>(`${w(slug)}/file${qs({ path, branch })}`),
  putFile: (slug: string, path: string, content: string, branch: string, previousPath?: string) =>
    jsonFetch<{ ok: true; branch: string; meta: DocumentMeta; content?: string; commit?: string }>(
      `${w(slug)}/file${qs({ path, branch })}`,
      { method: "PUT", body: JSON.stringify({ content, previous_path: previousPath }) },
    ),
  deleteFile: (slug: string, path: string, branch: string) =>
    jsonFetch<{ ok: true; branch: string }>(`${w(slug)}/file${qs({ path, branch })}`, {
      method: "DELETE",
    }),

  uploadAsset: async (slug: string, branch: string, file: File): Promise<{ path: string }> => {
    const form = new FormData();
    form.set("file", file);
    const pat = getStoredPat();
    const res = await fetch(`${w(slug)}/assets${qs({ branch })}`, {
      method: "POST",
      body: form,
      headers: pat ? { authorization: `Bearer ${pat}` } : undefined,
    });
    if (!res.ok) {
      let msg = `asset upload ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch (_err) {
        /* body wasn't JSON; keep the generic status message */
      }
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as { path: string };
  },

  suggest: (slug: string, params: { trigger: string; prefix: string; limit?: number }) =>
    jsonFetch<{ suggestions: Array<{ id: string; insert: string; display: string }> }>(
      `${w(slug)}/suggest${qs({
        trigger: params.trigger,
        prefix: params.prefix,
        limit: params.limit?.toString(),
      })}`,
    ),

  backlinks: (slug: string, id: string) =>
    jsonFetch<{ backlinks: Backlink[] }>(`${w(slug)}/backlinks${qs({ id })}`).then((r) => r.backlinks),
  validateWorkspace: (slug: string) =>
    jsonFetch<WorkspaceValidation>(`${w(slug)}/validation`),
  search: (slug: string, q: string) =>
    jsonFetch<{ results: SearchResult[] }>(`${w(slug)}/search${qs({ q })}`).then((r) => r.results),
};
