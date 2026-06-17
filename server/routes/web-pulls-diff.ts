// PR file-diff rendering for the server-rendered pull-request files page:
// source/rich modes, unified/split/after shapes, and inline line comments.
// Split out of web-pulls.ts (which keeps the pull lifecycle handlers) so each
// file stays focused; the handlers import the small exported surface here.

import { changedLines, commentableLines, patchRows } from "../diff-lines.js";
import { resolveLineComment, type Side } from "../diff-position.js";
import { splitUnifiedDiff } from "../diff-splitter.js";
import type { ForgejoPull } from "../forgejo.js";
import type { ForgejoPullReviewComment } from "../forgejo-types.js";
import { toEpochMs } from "../forgejo-types.js";
import { onForgejo404 } from "../forgejo-errors.js";
import { displayLogin, timeEl, repoHref, type WebCtx } from "./web-context.js";
import { html, type Html } from "./web-html.js";
import { renderMarkdownSurface } from "./web-markdown.js";

export type DiffMode = "source" | "rich";

export type DiffShape = "unified" | "split" | "after";

export interface PrFileView {
  path: string;
  previous_path?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

interface PrFileVersions {
  base: string;
  head: string;
}

interface WebLineComment {
  id: number;
  line: number | null;
  side: Side;
  bodyHtml: Html;
  author: string;
  createdAt: number;
  outdated: boolean;
}

// Rich diff renders through the Coflat reader island, which only exists for
// the coflat format. For forgejo-passthrough there is no rich surface, so we
// coerce to source regardless of the requested/saved mode — the server is the
// source of truth here, not the client default.
export function parseDiffMode(value: string | undefined, richOk: boolean): DiffMode {
  if (!richOk) return "source";
  return value === "source" ? "source" : "rich";
}

export function parseDiffShape(value: string | undefined, mode: DiffMode): DiffShape {
  const shape = value === "unified" || value === "split" || value === "after" ? value : "after";
  return mode === "rich" && shape === "unified" ? "after" : shape;
}

export async function prFileVersions(ctx: WebCtx, pull: ForgejoPull, file: { path: string; previous_path?: string }): Promise<PrFileVersions> {
  const read = (ref: string, p: string) => ctx.fj.getRawFile(ctx.owner, ctx.repo, ref, p).catch(onForgejo404(""));
  // A renamed file lives under its OLD name on the base ref; reading the new name
  // there would 404 → empty Base → wrong "new file" rendering (it isn't new).
  const [base, head] = await Promise.all([read(pull.base.ref, file.previous_path ?? file.path), read(pull.head.ref, file.path)]);
  return { base, head };
}

export async function renderPrFileView(
  ctx: WebCtx,
  pull: ForgejoPull,
  file: PrFileView,
  mode: DiffMode,
  shape: DiffShape,
  versions: PrFileVersions | null,
  comments: readonly WebLineComment[],
): Promise<Html> {
  if (mode === "source" && shape === "unified") {
    return html`<div data-testid="diff-pane-unified">${renderPatch(file.patch)}</div>`;
  }
  const nextVersions = versions ?? (await prFileVersions(ctx, pull, file));
  const changed = changedLines(file.patch);
  const commentable = commentableLines(file.patch);
  const commentForm = commentFormOptions(ctx, pull, file.path, mode, shape);
  if (mode === "source" && shape === "split") {
    return html`<div data-testid="diff-pane-split" class="source-split">
      ${sourcePane("Base", nextVersions.base, "base", file.status, changed.deleted, commentable.base, comments, commentForm)}
      ${sourcePane("Head", nextVersions.head, "head", file.status, changed.added, commentable.head, comments, commentForm)}
    </div>`;
  }
  if (mode === "source") {
    return html`<div data-testid="diff-pane-after" class="source-after">${sourcePane("After", nextVersions.head, "head", file.status, changed.added, commentable.head, comments, commentForm)}</div>`;
  }
  // Rich split: render each side through the reader, but show the empty-side
  // notice when a version is absent (new/deleted file) rather than a blank reader.
  const renderSide = (src: string, branch: string, marked: ReadonlySet<number>, side: Side): Promise<Html> =>
    src === ""
      ? Promise.resolve(diffSideEmptyNotice(file.status, side))
      : renderMarkdownSurface(ctx, src, { branch, documentPath: file.path, surface: "diff", markedLines: [...marked] });
  if (shape === "split") {
    const [base, head] = await Promise.all([
      renderSide(nextVersions.base, pull.base.ref, changed.deleted, "base"),
      renderSide(nextVersions.head, pull.head.ref, changed.added, "head"),
    ]);
    return html`<div data-testid="diff-pane-split" class="rich-split cf-theme-scope">
      <section><h3>Base</h3>${base}</section>
      <section><h3>Head</h3>${head}</section>
    </div>`;
  }
  // Rich "after": mark the changed head lines (surface "diff" + markedLines) like
  // the split head side, so changed blocks are highlighted and the change stepper
  // has hunks to navigate — not a plain unmarked document.
  const head =
    nextVersions.head === ""
      ? diffSideEmptyNotice(file.status, "head")
      : await renderMarkdownSurface(ctx, nextVersions.head, { branch: pull.head.ref, documentPath: file.path, surface: "diff", markedLines: [...changed.added] });
  return html`<div data-testid="diff-pane-after" class="rich-after cosheaf-document-reader cf-theme-scope">${head}</div>`;
}

export function diffModeControls(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape, richOk: boolean): Html {
  const href = (nextMode: DiffMode, nextShape: DiffShape) => prFilesHref(ctx, prNumber, filePath, nextMode, nextShape);
  const modeLink = (id: DiffMode, label: string) => {
    // Passthrough has no rich surface — show Rich as disabled, mirroring the
    // unified-disabled pattern below, so it is not clickable.
    if (id === "rich" && !richOk) return html`<span data-testid="view-mode-rich" class="disabled">${label}</span>`;
    return html`<a data-testid="view-mode-${id}" class="${mode === id ? "active" : ""}" href="${href(id, parseDiffShape(shape, id))}">${label}</a>`;
  };
  const shapeLink = (id: DiffShape, label: string) => {
    if (mode === "rich" && id === "unified") return html`<span data-testid="view-shape-unified" class="disabled">Unified</span>`;
    return html`<a data-testid="view-shape-${id}" class="${shape === id ? "active" : ""}" href="${href(mode, id)}">${label}</a>`;
  };
  return html`<div class="diff-controls">
    <div><span>View:</span>${modeLink("source", "Source")}${modeLink("rich", "Rich")}</div>
    <div><span>Shape:</span>${shapeLink("unified", "Unified")}${shapeLink("split", "Side-by-side")}${shapeLink("after", "After only")}</div>
  </div>`;
}

export function prFilesHref(ctx: WebCtx, prNumber: number, filePath: string, mode: DiffMode, shape: DiffShape): string {
  return `${repoHref(ctx.owner, ctx.repo, `/pulls/${prNumber}/files`)}?file=${encodeURIComponent(filePath)}&mode=${mode}&shape=${shape}`;
}

// A side with no content — a new file's Base, a deleted file's Head — is shown
// with an explicit notice rather than a blank box so it reads as intentional.
function diffSideEmptyNotice(status: string, side: Side): Html {
  // Key the message on the file status, not the side, so a renamed/modified file
  // with a momentarily-empty side is never mislabeled "New file" (#renamed).
  const text =
    status === "added"
      ? "New file — no previous version."
      : status === "deleted"
        ? "File deleted — no version on this side."
        : side === "base"
          ? "No content on the base side."
          : "No content on this side.";
  return html`<div class="diff-side-empty">${text}</div>`;
}

function sourcePane(
  title: string,
  source: string,
  side: Side,
  status: string,
  marked: ReadonlySet<number>,
  commentable: ReadonlySet<number>,
  comments: readonly WebLineComment[],
  form: LineCommentFormOptions | null,
): Html {
  const lines = source.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return html`<section><h3>${title}</h3>${diffSideEmptyNotice(status, side)}</section>`;
  return html`<section><h3>${title}</h3><table class="source-lines"><tbody>${lines.map((line, index) => {
    const lineNo = index + 1;
    const lineComments = comments.filter((comment) => comment.side === side && comment.line === lineNo);
    const composer = form && commentable.has(lineNo) ? lineCommentComposer(form, side, lineNo) : "";
    return html`<tr class="${marked.has(lineNo) ? "marked" : ""}" data-testid="source-line-${side}-${lineNo}">
        <td class="line-action">${composer}</td>
        <td>${lineNo}</td>
        <td><pre>${line}</pre></td>
      </tr>${lineComments.map(renderInlineComment)}`;
  })}</tbody></table></section>`;
}

interface LineCommentFormOptions {
  action: string;
  path: string;
  mode: DiffMode;
  shape: DiffShape;
}

function commentFormOptions(
  ctx: WebCtx,
  pull: ForgejoPull,
  filePath: string,
  mode: DiffMode,
  shape: DiffShape,
): LineCommentFormOptions | null {
  if (pull.state === "closed") return null;
  return {
    action: repoHref(ctx.owner, ctx.repo, `/pulls/${pull.number}/comments`),
    path: filePath,
    mode,
    shape,
  };
}

function lineCommentComposer(form: LineCommentFormOptions, side: Side, line: number): Html {
  // A write control — hidden in Read mode (#171); the diff itself stays readable.
  return html`<details class="line-composer build-only">
    <summary aria-label="Comment on line ${line}">+</summary>
    <form method="post" action="${form.action}">
      <input type="hidden" name="path" value="${form.path}">
      <input type="hidden" name="side" value="${side}">
      <input type="hidden" name="line" value="${line}">
      <input type="hidden" name="mode" value="${form.mode}">
      <input type="hidden" name="shape" value="${form.shape}">
      <textarea name="body" required></textarea>
      <button type="submit">Comment</button>
    </form>
  </details>`;
}

function renderInlineComment(comment: WebLineComment): Html {
  return html`<tr class="line-comment-row" data-testid="line-comment-${comment.id}">
    <td></td>
    <td colspan="2">
      <div class="line-comment ${comment.outdated ? "outdated" : ""}">
        <strong>${comment.author}</strong>
        <span>${comment.outdated ? "outdated" : timeEl(comment.createdAt)}</span>
        ${comment.bodyHtml}
      </div>
    </td>
  </tr>`;
}

// Render each comment body through the same markdown surface the conversation
// timeline uses, so a `**bold**`/`[@ref]` comment renders identically on the
// Files-changed tab instead of showing raw, escaped markdown.
export async function mapLineComments(
  ctx: WebCtx,
  file: PrFileView,
  comments: readonly ForgejoPullReviewComment[],
): Promise<WebLineComment[]> {
  const mine = comments.filter((comment) => comment.path === file.path);
  return Promise.all(
    mine.map(async (comment) => {
      const { line, side, outdated } = resolveLineComment(comment, file.status);
      return {
        id: comment.id,
        line,
        side,
        bodyHtml: await renderMarkdownSurface(ctx, comment.body, { surface: "thread" }),
        author: displayLogin(comment.user?.login),
        createdAt: toEpochMs(comment.created_at),
        outdated,
      };
    }),
  );
}

export function renderFileCommentSummary(comments: readonly WebLineComment[]): Html {
  if (comments.length === 0) return html`<div class="file-comments empty">No line comments.</div>`;
  return html`<div class="file-comments">${comments.map(
    (comment) => html`<div class="file-comment ${comment.outdated ? "outdated" : ""}">
        <div><strong>${comment.author}</strong><span>${comment.side}:${comment.line ?? "outdated"}</span></div>
        ${comment.bodyHtml}
      </div>`,
  )}</div>`;
}

export function splitDiffByFile(diff: string): Map<string, string> {
  return new Map(splitUnifiedDiff(diff).map((file) => [file.path, file.patch]));
}

function renderPatch(patch: string): Html {
  // A binary edit or a pure rename has a non-empty header-only patch but zero
  // body rows; show the placeholder instead of an empty table (#1).
  const rows = patch ? patchRows(patch) : [];
  if (rows.length === 0) return html`<pre class="patch empty">No textual diff.</pre>`;
  return html`<table class="patch"><tbody>${rows.map(
    (row) => html`<tr class="${row.kind}"><td class="sign">${row.sign}</td><td><pre>${row.text}</pre></td></tr>`,
  )}</tbody></table>`;
}
