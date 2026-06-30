/**
 * Host implementation of the coflat editor's `openBibliographyPicker` request.
 *
 * The document-properties panel's Bibliography field shows a "Browse…" button
 * when the editor is given a `RequestHandler` with this method. It lists the
 * workspace's `.bib` files (from the repo tree) and returns the chosen path,
 * resolved relative to the document so the frontmatter `bibliography:` value
 * resolves the same way the reader does.
 */

import { relativeMarkdownReferencePathFromDocument } from "@chaoxu/coflat/parse";

interface BibliographyPickerContext {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  /** Repo-relative path of the document being edited. */
  readonly docPath: string;
}

interface PickerRequest {
  readonly current: string;
  readonly signal: AbortSignal;
}

interface PickerResult {
  readonly path: string;
}

async function fetchBibFiles(ctx: BibliographyPickerContext, signal: AbortSignal): Promise<string[]> {
  const url = `/api/v1/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/tree?ref=${encodeURIComponent(ctx.branch)}`;
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { files?: ReadonlyArray<{ path: string }> };
  return (data.files ?? []).map((f) => f.path).filter((p) => p.toLowerCase().endsWith(".bib"));
}

/** Render a minimal modal list of `.bib` paths and resolve the user's choice. */
function chooseBibFile(repoPaths: readonly string[], ctx: BibliographyPickerContext, signal: AbortSignal): Promise<PickerResult | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cosheaf-bib-picker";

    const heading = document.createElement("h2");
    heading.className = "cosheaf-bib-picker-title";
    heading.textContent = "Choose a bibliography file";
    dialog.append(heading);

    const list = document.createElement("div");
    list.className = "cosheaf-bib-picker-list";
    for (const repoPath of repoPaths) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cosheaf-bib-picker-item";
      item.textContent = repoPath;
      item.addEventListener("click", () =>
        finish({ path: relativeMarkdownReferencePathFromDocument(ctx.docPath, repoPath) }),
      );
      list.append(item);
    }
    dialog.append(list);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cosheaf-bib-picker-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => finish(null));
    dialog.append(cancel);

    let settled = false;
    const finish = (result: PickerResult | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const onAbort = (): void => finish(null);
    signal.addEventListener("abort", onAbort);
    dialog.addEventListener("cancel", () => finish(null));

    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Build the `openBibliographyPicker` request handler for a workspace document. */
export function createBibliographyPicker(
  ctx: BibliographyPickerContext,
): (req: PickerRequest) => Promise<PickerResult | null> {
  return async (req) => {
    let bibs: string[];
    try {
      bibs = await fetchBibFiles(ctx, req.signal);
    } catch (_error) {
      return null;
    }
    if (req.signal.aborted || bibs.length === 0) return null;
    return chooseBibFile(bibs, ctx, req.signal);
  };
}
