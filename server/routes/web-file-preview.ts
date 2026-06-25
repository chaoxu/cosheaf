import type { FileKind } from "../../shared/file-kind.js";
import { COFLAT_FILE_PREVIEW_TEST_ID, COFLAT_READER_ARTICLE_CLASS } from "../../shared/coflat-reader-surface.js";
import { isLikelyTextContent } from "../content-type.js";
import type { Forgejo } from "../forgejo.js";
import type { WebCtx } from "./web-context.js";
import { emptyHtml, html, type Html } from "./web-html.js";
import { rawFileHref } from "./web-file-links.js";
import { markdownSurface } from "./web-markdown.js";

const INLINE_TEXT_PREVIEW_MAX_BYTES = 256 * 1024;

export function editableFileKind(kind: FileKind): boolean {
  return kind === "markdown" || kind === "text";
}

export async function previewKindForFile(
  fj: Forgejo,
  owner: string,
  repo: string,
  branch: string,
  rel: string,
  kind: FileKind,
  size: number,
): Promise<FileKind> {
  if (kind !== "binary" || size > INLINE_TEXT_PREVIEW_MAX_BYTES) return kind;
  const content = await fj.getRawFileBytes(owner, repo, branch, rel);
  return isLikelyTextContent(content) ? "text" : kind;
}

export function filePreview(
  ctx: WebCtx,
  branch: string,
  rel: string,
  kind: FileKind,
  view: { rendered: Html | null; source: string | null; sourceView: boolean },
): Html {
  const rawHref = rawFileHref(ctx.owner, ctx.repo, branch, rel);
  if (view.sourceView && view.source !== null) return sourceFilePreview(view.source);
  if (kind === "markdown") {
    return markdownArticle(ctx, view.rendered ?? emptyHtml, COFLAT_FILE_PREVIEW_TEST_ID);
  }
  if (kind === "text") {
    return html`<article class="file-preview file-preview-embed" data-testid="file-preview-text">
      <object data-testid="file-preview-text-raw" data="${rawHref}" type="text/plain">
        <p>Text preview is not available in this browser. <a class="inline-link" href="${rawHref}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "pdf") {
    return html`<article class="file-preview file-preview-embed">
      <object data-testid="file-preview-pdf" data="${rawHref}" type="application/pdf">
        <p>PDF preview is not available in this browser. <a class="inline-link" href="${rawHref}">Open the raw file.</a></p>
      </object>
    </article>`;
  }
  if (kind === "image") {
    return html`<article class="file-preview file-preview-image">
      <img data-testid="file-preview-image" src="${rawHref}" alt="${rel}">
    </article>`;
  }
  return html`<article class="file-preview file-preview-fallback" data-testid="file-preview-raw">
    <p>No inline preview is available for this file type.</p>
    <a class="button" href="${rawHref}">Open raw file</a>
  </article>`;
}

export function markdownArticle(ctx: WebCtx, rendered: Html, testId: string): Html {
  return html`<article class="${COFLAT_READER_ARTICLE_CLASS}" data-testid="${testId}">
    ${markdownSurface(ctx, rendered)}
  </article>`;
}

function sourceFilePreview(content: string): Html {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return html`<article class="file-preview file-preview-source-lines" data-testid="file-preview-source">
    <table class="source-lines"><tbody>${lines.map((line, index) => {
      const lineNo = index + 1;
      return html`<tr id="L${lineNo}" data-testid="source-line-${lineNo}">
          <td class="line-action"></td>
          <td><a href="#L${lineNo}">${lineNo}</a></td>
          <td><pre>${line}</pre></td>
        </tr>`;
    })}</tbody></table>
    <script>
      (() => {
        const match = /^#L(\\d+)(?:-(?:L)?(\\d+))?$/.exec(window.location.hash);
        if (!match) return;
        const first = Number(match[1]);
        const last = Number(match[2] || match[1]);
        const start = Math.max(1, Math.min(first, last));
        const end = Math.max(first, last);
        for (let line = start; line <= end; line += 1) {
          document.getElementById("L" + line)?.classList.add("marked");
        }
        document.getElementById("L" + start)?.scrollIntoView({ block: "center" });
      })();
    </script>
  </article>`;
}
