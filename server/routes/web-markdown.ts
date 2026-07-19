import type { AssetPreviewPaths } from "../../shared/asset-previews.js";
import {
  type CoflatReaderSurface,
  coflatReaderIslandClass,
  coflatReaderSurfaceClass,
} from "../../shared/coflat-reader-surface.js";
import { referencedCrossrefKeys } from "../../shared/coflat-xrefs.js";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { type ResolvedRef, resolveWorkspaceCrossrefs } from "../page-search.js";
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
  // Logged-out visitor: the crossref-resolution endpoint (/api/v1/.../refs) stays
  // auth-gated, so the reader skips that fetch rather than emit a 401 (citation
  // sources come from the /raw web route, which does serve anonymous public reads).
  anonymous?: boolean;
  // Cross-file `[@id]` refs pre-resolved from the sidecar and embedded for the
  // primary document reader on main, so the island renders resolved crossrefs
  // without the auth-gated /refs fetch (works logged-out; also saves signed-in
  // readers a round-trip). Absent on branch views, which keep the client fetch.
  crossrefs?: ResolvedRef[];
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
    ...(ctx.anonymous ? { anonymous: true } : {}),
  };
}

function coflatReaderIsland(ctx: WebCtx, source: string, opts: SurfaceOpts, repoConfig: Awaited<ReturnType<typeof loadRepoConfig>>): Html {
  const payload = coflatReaderPayload(ctx, source, opts, repoConfig);
  const className = coflatReaderIslandClass(opts.surface ?? "document");
  const resourceRef = payload.branchExists === false ? "main" : payload.branch;
  const fallbackRefs = resourceRef === "main" ? "main" : `${resourceRef},main`;
  // Pre-resolve cross-file refs from the sidecar (which reflects main) and embed
  // them for the primary document reader — renderTitle marks the file/README
  // view. Gate on branch === "main" (not resourceRef): the sidecar reflects
  // main and the island builds hrefs against payload.branch, so embedding only
  // when actually on main keeps links pointing at a branch that exists. The
  // island then renders resolved crossrefs without the auth-gated /refs fetch,
  // so a logged-out public read gets them too. Branch views keep the fetch path.
  if (opts.renderTitle && payload.branch === "main" && payload.branchExists !== false) {
    const keys = referencedCrossrefKeys(source);
    if (keys.length > 0) {
      try {
        const { refs } = resolveWorkspaceCrossrefs(ctx.db, ctx.ws.slug, keys);
        if (refs.length > 0) payload.crossrefs = refs;
      } catch (_error) {
        // A sidecar read error (e.g. SQLITE_BUSY during a concurrent reindex)
        // must not 500 the page. Skip the embed; the island falls back to the
        // authed /refs fetch, or bare refs when logged out — the prior behavior.
      }
    }
  }
  return html`<div
    class="${className}"
    data-reader-branch="${payload.branch}"
    data-render-document-ref="${payload.branch}"
    data-render-resource-ref="${resourceRef}"
    data-render-resource-fallback-refs="${fallbackRefs}"
    data-render-path="${payload.path}"
  ><script type="application/json">${jsonScript(payload)}</script></div>`;
}

// A markdown compose/edit field. It renders a textarea (the real, submitted
// form field) wrapped in a `[data-coflat-compose]` container that the
// web-comment-editor island enhances with the rich Coflat editor.
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
