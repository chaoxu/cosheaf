import type { FileKind } from "../../shared/file-kind.js";
import { editHref } from "./web-file-links.js";
import { editableFileKind } from "./web-file-preview.js";
import { repoHref, type WebCtx, urlPath } from "./web-context.js";
import { emptyHtml, html, type Html } from "./web-html.js";

// The per-file action toolbar on the file-view page: the primary write controls
// stay visible; secondary representations (Raw, Source/Rendered) sit in a small
// menu so the reader's top row stays about the document.
// (#171). Extracted from the file-view handler (#24) to keep the handler legible.
export function fileToolbar(
  ctx: WebCtx,
  opts: { branch: string; rel: string; kind: FileKind; fileHref: string; sourceView: boolean; sha: string; showEdit?: boolean; showRepresentations?: boolean },
): Html {
  const { owner, repo, user } = ctx;
  const role = ctx.ws.role;
  const { branch, rel, kind, fileHref, sourceView } = opts;
  return html`<div class="toolbar-actions">
    ${
      role === "read" || branch === "main"
        ? ""
        : html`<a class="button" href="${`${repoHref(owner, repo, "/pulls/new")}?head=${encodeURIComponent(branch)}&base=main`}">Open PR</a>`
    }
    ${
      role === "read" || opts.showEdit === false
        ? ""
        : editableFileKind(kind)
          ? html`<a class="button primary" href="${editHref(owner, repo, user, branch, rel)}">${kind === "markdown" ? "Edit" : "Edit text"}</a>`
          : ""
    }
    ${opts.showRepresentations === false ? emptyHtml : fileRepresentationMenu(owner, repo, branch, rel, kind, fileHref, sourceView)}
    ${
      role === "read" || branch === "main"
        ? ""
        : html`<form class="inline-form" method="post" action="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`}">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="expected_sha" value="${opts.sha}">
            <button class="button danger" type="submit" data-testid="file-delete">Delete</button>
          </form>`
    }
  </div>`;
}

function fileRepresentationMenu(
  owner: string,
  repo: string,
  branch: string,
  rel: string,
  kind: FileKind,
  fileHref: string,
  sourceView: boolean,
): Html {
  return html`<details class="action-menu">
    <summary class="button">More</summary>
    <div class="action-menu-popover">
      ${
        kind === "markdown"
          ? sourceView
            ? html`<a href="${fileHref}">Rendered</a>`
            : html`<a href="${`${fileHref}?view=source`}">Source</a>`
          : emptyHtml
      }
      <a href="${`${repoHref(owner, repo, "/raw/branch")}/${urlPath(branch)}/${urlPath(rel)}`}">Raw</a>
    </div>
  </details>`;
}
