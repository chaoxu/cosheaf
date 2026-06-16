import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { loadRepoConfig } from "../repo-config.js";
import type { WebCtx } from "./web-context.js";
import { emptyHtml, html, type Html, jsonScript, raw } from "./web-html.js";

export type MarkdownSurface = "document" | "thread" | "diff";

// `markedLines` (source line numbers) are only passed for the diff surface: the
// reader renders with sourceLineAttribution and highlights blocks whose source
// range intersects this set (changed lines on this side of the PR diff, #113).
export type SurfaceOpts = {
  branch?: string;
  documentPath?: string;
  surface?: MarkdownSurface;
  markedLines?: readonly number[];
  // Render the frontmatter title as a .cf-doc-title heading (the file view +
  // README landing set this). Explicit — not inferred from `surface` — because
  // the rich-diff "after" pane also renders with surface "document" but must NOT
  // show a title.
  renderTitle?: boolean;
};

function coflatSurfaceClass(surface: MarkdownSurface): string {
  if (surface === "thread") return "cf-reader-compact";
  if (surface === "diff") return "cf-rich-diff cf-reader-compact";
  return "";
}

export async function renderMarkdown(ctx: WebCtx, source: string, opts: SurfaceOpts = {}): Promise<Html> {
  const { body } = parseFrontmatterYaml(source);
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) {
    // Repo-wide math macros (#183) live in cosheaf.yaml (#182), cached per
    // branch; thread them into every coflat surface via the island payload so
    // they apply to documents, issue/PR/comment bodies, and diffs alike.
    const { mathMacros } = await loadRepoConfig(ctx.db, ctx.fj, ctx.owner, ctx.repo, opts.branch ?? "main");
    return coflatReaderIsland(ctx, source, opts, mathMacros);
  }
  // Forgejo's repo-scoped /markdown endpoint returns sanitized HTML; it is
  // the rendered document, not text content.
  return raw(await ctx.fj.renderMarkdown(ctx.owner, ctx.repo, body));
}

export async function renderMarkdownSurface(ctx: WebCtx, source: string, opts: SurfaceOpts = {}): Promise<Html> {
  const rendered = await renderMarkdown(ctx, source, opts);
  return markdownSurface(ctx, rendered, opts.surface ?? "document");
}

function coflatReaderIsland(ctx: WebCtx, source: string, opts: SurfaceOpts, mathMacros: Record<string, string> = {}): Html {
  const payload = {
    source,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: opts.branch ?? "main",
    path: opts.documentPath ?? "",
    ...(opts.markedLines?.length ? { markedLines: opts.markedLines } : {}),
    // Doc title is opt-in per call site (file view / README), never on comment
    // threads or the rich-diff "after" pane (which also uses surface "document").
    ...(opts.renderTitle ? { renderTitle: true } : {}),
    // Repo-wide KaTeX macros (#183); the reader merges the doc's own frontmatter
    // math on top (doc overrides repo) when building the document context.
    ...(Object.keys(mathMacros).length ? { mathMacros } : {}),
  };
  const className = ["cf-reader", "cf-doc-surface", "cf-doc-flow", "coflat-reader-island", coflatSurfaceClass(opts.surface ?? "document")]
    .filter(Boolean)
    .join(" ");
  return html`<div class="${className}" data-reader-branch="${payload.branch}"><script type="application/json">${jsonScript(payload)}</script></div>`;
}

// A markdown compose/edit field. On coflat workspaces it renders a textarea
// (the real, submitted form field) wrapped in a `[data-coflat-compose]`
// container that the web-comment-editor island enhances with the rich coflat
// editor; on forgejo-passthrough it renders just the plain textarea, unchanged.
// The textarea value is escaped by the template — never interpolated raw.
export function composeField(
  ctx: WebCtx,
  opts: {
    name?: string;
    value?: string;
    placeholder?: string;
    required?: boolean;
    testId?: string;
    className?: string;
    branch?: string;
  } = {},
): Html {
  const name = opts.name ?? "body";
  const value = opts.value ?? "";
  const attrs = html`name="${name}"${opts.placeholder ? html` placeholder="${opts.placeholder}"` : emptyHtml}${
    opts.required ? raw(" required") : emptyHtml
  }${opts.testId ? html` data-testid="${opts.testId}"` : emptyHtml}${opts.className ? html` class="${opts.className}"` : emptyHtml}`;
  const textarea = html`<textarea ${attrs}>${value}</textarea>`;
  if (ctx.ws.defaultMdFormat !== COFLAT_FORMAT_ID) return textarea;
  return html`<div class="coflat-compose" data-coflat-compose data-owner="${ctx.owner}" data-repo="${ctx.repo}" data-branch="${opts.branch ?? "main"}">${textarea}<div class="coflat-compose-mount"></div></div>`;
}

export function markdownSurface(ctx: WebCtx, rendered: Html, surface: MarkdownSurface = "document"): Html {
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) return rendered;
  const className = ["markdown-body", "cf-reader", "cf-doc-surface", "cf-doc-flow", coflatSurfaceClass(surface)]
    .filter(Boolean)
    .join(" ");
  return html`<div class="${className}">${rendered}</div>`;
}
