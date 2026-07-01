import type { CoflatReviewCommentAnchor, CoflatReviewCommentForm } from "./coflat-document-context";
import { richDiffBlockForLine } from "./reader-diff-marking";
import { sanitizeAndRewriteRefsFragment } from "./ref-rewriter";

export function placeReviewComments(root: HTMLElement, comments: readonly CoflatReviewCommentAnchor[]): void {
  for (const old of root.querySelectorAll(".rich-review-comment")) old.remove();
  const grouped = new Map<HTMLElement, CoflatReviewCommentAnchor[]>();
  for (const comment of comments) {
    const target = richDiffBlockForLine(root, comment.line);
    if (!target) continue;
    const host = reviewCommentHost(target);
    grouped.set(host, [...(grouped.get(host) ?? []), comment]);
  }
  for (const [target, targetComments] of grouped) {
    const wrap = document.createElement("div");
    wrap.className = "rich-review-comments";
    for (const comment of targetComments) {
      const card = document.createElement("article");
      card.className = "rich-review-comment";
      card.dataset.commentId = String(comment.id);
      card.dataset.commentSide = comment.side;
      card.dataset.commentLine = String(comment.line);
      if (comment.outdated) card.classList.add("outdated");
      const header = document.createElement("div");
      header.className = "rich-review-comment-header";
      const author = document.createElement("strong");
      author.textContent = comment.author;
      const meta = document.createElement("span");
      meta.textContent = comment.outdated ? "outdated" : `${comment.side}:${comment.line}`;
      header.append(author, meta);
      const body = document.createElement("p");
      if (comment.bodyHtml) {
        // Sanitize on the island like every other rendered-HTML insertion here
        // (document body, line ~83). Defense-in-depth per the CLAUDE.md rule, and
        // it covers the coflat surface path where bodyHtml isn't forge-sanitized.
        body.replaceChildren(sanitizeAndRewriteRefsFragment(comment.bodyHtml));
      } else {
        body.textContent = comment.body;
      }
      card.append(header, body);
      wrap.append(card);
    }
    target.insertAdjacentElement("afterend", wrap);
  }
}

export function placeReviewCommentComposers(root: HTMLElement, form: CoflatReviewCommentForm, source: string): void {
  for (const old of root.querySelectorAll(".rich-line-composer")) old.remove();
  const seenHosts = new Set<HTMLElement>();
  for (const line of form.lines) {
    const target = richDiffBlockForLine(root, line);
    if (!target) continue;
    const host = reviewCommentHost(target);
    if (seenHosts.has(host)) continue;
    seenHosts.add(host);
    host.classList.add("rich-commentable");
    placeReviewCommentComposer(host, reviewCommentComposer(form, line, `Comment on line ${line}`, host));
  }
  placeBibliographyReviewCommentComposers(root, form, source);
}

function placeReviewCommentComposer(host: HTMLElement, composer: HTMLDetailsElement): void {
  if (host.classList.contains("cf-doc-section-heading-collapsible")) {
    composer.classList.add("rich-line-composer-before");
    host.insertAdjacentElement("beforebegin", composer);
    return;
  }
  host.insertAdjacentElement("afterend", composer);
}

function placeBibliographyReviewCommentComposers(root: HTMLElement, form: CoflatReviewCommentForm, source: string): void {
  const commentable = new Set(form.lines);
  if (commentable.size === 0) return;
  for (const entry of root.querySelectorAll<HTMLElement>(".cf-bibliography-entry")) {
    const key = entry.dataset.citationKey;
    const line = bibliographyEntryCommentLine(entry, source, commentable);
    if (line === null) continue;
    entry.classList.add("rich-commentable");
    entry.insertAdjacentElement(
      "afterend",
      reviewCommentComposer(form, line, key ? `Comment on reference ${key} at line ${line}` : `Comment on reference at line ${line}`, entry),
    );
  }
}

function bibliographyEntryCommentLine(entry: HTMLElement, source: string, commentable: ReadonlySet<number>): number | null {
  const offsets = [...entry.querySelectorAll<HTMLElement>(".cf-bibliography-backlink[data-source-from]")]
    .map((link) => Number(link.dataset.sourceFrom))
    .filter((offset) => Number.isFinite(offset) && offset >= 0)
    .sort((a, b) => a - b);
  for (const offset of offsets) {
    const line = sourceLineForOffset(source, offset);
    if (commentable.has(line)) return line;
  }
  return null;
}

function sourceLineForOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < source.length && i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function reviewCommentComposer(form: CoflatReviewCommentForm, line: number, label: string, host: HTMLElement): HTMLDetailsElement {
  const composer = document.createElement("details");
  composer.className = "line-composer rich-line-composer";
  composer.style.setProperty("--rich-composer-host-height", `${Math.max(22, Math.ceil(host.getBoundingClientRect().height))}px`);
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", label);
  summary.textContent = "+";
  const formEl = document.createElement("form");
  formEl.method = "post";
  formEl.action = form.action;
  for (const [name, value] of [
    ["path", form.path],
    ["side", form.side],
    ["line", String(line)],
    ["mode", form.mode],
    ["shape", form.shape],
  ] as const) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    formEl.append(input);
  }
  const textarea = document.createElement("textarea");
  textarea.name = "body";
  textarea.required = true;
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Comment";
  formEl.append(textarea, button);
  composer.append(summary, formEl);
  return composer;
}

function reviewCommentHost(target: HTMLElement): HTMLElement {
  return target.closest<HTMLElement>(".cf-doc-paragraph, .cf-doc-heading, .cf-doc-list-item, li, .cf-doc-block, .cf-code-block, blockquote, table")
    ?? target;
}
