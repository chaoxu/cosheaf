// Workspace-scoped DocumentContext shared between the editor surface
// (coflat's mountEditor via documentContextFacet) and the reader surface
// (IssueBodyRender via renderToHtml).
//
// One instance per workspace lets coflat tooltips / link decorations
// agree with rendered issue/comment bodies on what `[@id]` resolves to.

import type { DocumentContext } from "@chaoxu/coflat-editor/reader";
import type { FileEntry } from "./api";

export interface WorkspaceContextOptions {
  files: readonly FileEntry[] | null;
}

export function buildWorkspaceDocumentContext(opts: WorkspaceContextOptions): DocumentContext {
  const byId = new Map<string, FileEntry>();
  for (const f of opts.files ?? []) {
    if (f.doc?.id) byId.set(f.doc.id, f);
  }
  return {
    refResolver: {
      resolve(key, _mode) {
        const file = byId.get(key);
        if (!file) {
          // Unresolved — keep the literal bracketed form so authors notice
          // the broken reference; click still routes to onOpenPageById in
          // case the host has fuzzy lookup.
          return {
            content: `[@${escapeHtml(key)}]`,
            className: "cosheaf-ref-page cosheaf-ref-button",
          };
        }
        const title = file.doc?.title ?? key;
        return {
          content: escapeHtml(title),
          className: "cosheaf-ref-page cosheaf-ref-button",
        };
      },
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
