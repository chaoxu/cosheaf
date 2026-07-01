import type { AssetPreviewPaths } from "../../shared/asset-previews.js";
import {
  type CoflatReaderSurface,
  coflatReaderIslandClass,
  coflatReaderSurfaceClass,
} from "../../shared/coflat-reader-surface.js";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { loadRepoConfig } from "../repo-config.js";
import type { WebCtx } from "./web-context.js";
import { emptyHtml, type Html, html, jsonScript, raw } from "./web-html.js";

export type MarkdownSurface = CoflatReaderSurface;

// `markedLines` (source line numbers) are only passed for the diff surface: the
// reader renders with sourceLineAttribution and highlights blocks whose source
// range intersects this set (changed lines on this side of the PR diff, #113).
export type SurfaceOpts = {
  branch?: string;
  branchExists?: boolean;
  documentPath?: string;
  surface?: MarkdownSurface;
  markedLines?: readonly number[];
  changeStops?: readonly number[];
  richGapAnchors?: readonly {
    id: string;
    line: number;
    role: "content" | "gap";
    placement?: "before" | "after";
  }[];
  richInlineRanges?: readonly {
    from: number;
    to: number;
    kind: "del" | "add";
  }[];
  // Render the frontmatter title as a .cf-doc-title heading (the file view +
  // README landing set this). Explicit — not inferred from `surface` — because
  // the rich-diff "after" pane also renders with surface "document" but must NOT
  // show a title.
  renderTitle?: boolean;
  assetPreviewPaths?: AssetPreviewPaths;
  sourcePositions?: boolean;
  reviewComments?: readonly {
    id: number;
    line: number;
    side: "base" | "head";
    author: string;
    body: string;
    bodyHtml?: string;
    outdated?: boolean;
  }[];
  reviewCommentForm?: {
    action: string;
    path: string;
    side: "base" | "head";
    mode: "source" | "rich";
    shape: "unified" | "split" | "after";
    lines: readonly number[];
  };
};

type CoflatReaderPayload = {
  source: string;
  owner: string;
  repo: string;
  branch: string;
  branchExists?: boolean;
  path: string;
  markedLines?: readonly number[];
  changeStops?: readonly number[];
  richGapAnchors?: SurfaceOpts["richGapAnchors"];
  richInlineRanges?: SurfaceOpts["richInlineRanges"];
  renderTitle?: boolean;
  mathMacros?: Record<string, string>;
  bibliography?: string;
  csl?: string;
  assetPreviewPaths?: AssetPreviewPaths;
  sourcePositions?: boolean;
  reviewComments?: SurfaceOpts["reviewComments"];
  reviewCommentForm?: SurfaceOpts["reviewCommentForm"];
};

export async function renderMarkdown(ctx: WebCtx, source: string, opts: SurfaceOpts = {}): Promise<Html> {
  if (ctx.coflat) {
    // Repo-wide math macros (#183) live in cosheaf.yaml (#182), cached per
    // branch; thread them into every coflat surface via the island payload so
    // they apply to documents, issue/PR/comment bodies, and diffs alike.
    const repoConfig = await loadRepoConfig(ctx.db, ctx.backend, ctx.owner, ctx.repo, opts.branch ?? "main");
    return coflatReaderIsland(ctx, source, opts, repoConfig);
  }
  const { body } = parseFrontmatterYaml(source);
  // Forgejo's repo-scoped /markdown endpoint returns sanitized HTML; it is
  // the rendered document, not text content.
  return raw(await ctx.collab.renderMarkdown(ctx.owner, ctx.repo, body));
}

export async function renderMarkdownSurface(ctx: WebCtx, source: string, opts: SurfaceOpts = {}): Promise<Html> {
  const rendered = await renderMarkdown(ctx, source, opts);
  return markdownSurface(ctx, rendered, opts.surface ?? "document");
}

export function coflatReaderPayload(ctx: WebCtx, source: string, opts: SurfaceOpts, repoConfig: Awaited<ReturnType<typeof loadRepoConfig>>): CoflatReaderPayload {
  return {
    source,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: opts.branch ?? "main",
    ...(opts.branchExists === false ? { branchExists: false } : {}),
    path: opts.documentPath ?? "",
    ...(opts.markedLines?.length ? { markedLines: opts.markedLines } : {}),
    ...(opts.changeStops?.length ? { changeStops: opts.changeStops } : {}),
    ...(opts.richGapAnchors?.length ? { richGapAnchors: opts.richGapAnchors } : {}),
    ...(opts.richInlineRanges?.length ? { richInlineRanges: opts.richInlineRanges } : {}),
    // Doc title is opt-in per call site (file view / README), never on comment
    // threads or the rich-diff "after" pane (which also uses surface "document").
    ...(opts.renderTitle ? { renderTitle: true } : {}),
    // Repo-wide KaTeX macros (#183); the reader merges the doc's own frontmatter
    // math on top (doc overrides repo) when building the document context.
    ...(Object.keys(repoConfig.mathMacros).length ? { mathMacros: repoConfig.mathMacros } : {}),
    ...(repoConfig.bibliography ? { bibliography: repoConfig.bibliography } : {}),
    ...(repoConfig.csl ? { csl: repoConfig.csl } : {}),
    ...(opts.assetPreviewPaths && Object.keys(opts.assetPreviewPaths).length ? { assetPreviewPaths: opts.assetPreviewPaths } : {}),
    ...(opts.sourcePositions ? { sourcePositions: true } : {}),
    ...(opts.reviewComments?.length ? { reviewComments: opts.reviewComments } : {}),
    ...(opts.reviewCommentForm && opts.reviewCommentForm.lines.length ? { reviewCommentForm: opts.reviewCommentForm } : {}),
  };
}

function coflatReaderIsland(ctx: WebCtx, source: string, opts: SurfaceOpts, repoConfig: Awaited<ReturnType<typeof loadRepoConfig>>): Html {
  const payload = coflatReaderPayload(ctx, source, opts, repoConfig);
  const className = coflatReaderIslandClass(opts.surface ?? "document");
  const resourceRef = payload.branchExists === false ? "main" : payload.branch;
  const fallbackRefs = resourceRef === "main" ? "main" : `${resourceRef},main`;
  return html`<div
    class="${className}"
    data-reader-branch="${payload.branch}"
    data-render-document-ref="${payload.branch}"
    data-render-resource-ref="${resourceRef}"
    data-render-resource-fallback-refs="${fallbackRefs}"
    data-render-path="${payload.path}"
  ><script type="application/json">${jsonScript(payload)}</script></div>`;
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
  if (!ctx.coflat) return textarea;
  return html`<div class="coflat-compose" data-coflat-compose data-owner="${ctx.owner}" data-repo="${ctx.repo}" data-branch="${opts.branch ?? "main"}">${textarea}<div class="coflat-compose-mount"></div></div>`;
}

export function markdownSurface(ctx: WebCtx, rendered: Html, surface: MarkdownSurface = "document"): Html {
  if (ctx.coflat) return rendered;
  const className = ["markdown-body", coflatReaderSurfaceClass(surface)]
    .filter(Boolean)
    .join(" ");
  return html`<div class="${className}">${rendered}</div>`;
}
