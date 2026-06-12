import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";
import { jsonScript, type WebCtx } from "./web-context.js";
import { html, type Html, raw } from "./web-html.js";

export type MarkdownSurface = "document" | "thread" | "diff";

function coflatSurfaceClass(surface: MarkdownSurface): string {
  if (surface === "thread") return "cf-reader-compact";
  if (surface === "diff") return "cf-rich-diff cf-reader-compact";
  return "";
}

export async function renderMarkdown(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface } = {},
): Promise<Html> {
  const { body } = parseFrontmatterYaml(source);
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) {
    return coflatReaderIsland(ctx, source, opts);
  }
  // Forgejo's repo-scoped /markdown endpoint returns sanitized HTML; it is
  // the rendered document, not text content.
  return raw(await ctx.fj.renderMarkdown(ctx.owner, ctx.repo, body));
}

export async function renderMarkdownSurface(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface } = {},
): Promise<Html> {
  const rendered = await renderMarkdown(ctx, source, opts);
  return markdownSurface(ctx, rendered, opts.surface ?? "document");
}

function coflatReaderIsland(
  ctx: WebCtx,
  source: string,
  opts: { branch?: string; documentPath?: string; surface?: MarkdownSurface },
): Html {
  const payload = {
    source,
    owner: ctx.owner,
    repo: ctx.repo,
    branch: opts.branch ?? "main",
    path: opts.documentPath ?? "",
  };
  const className = ["cf-reader", "cf-doc-surface", "cf-doc-flow", "coflat-reader-island", coflatSurfaceClass(opts.surface ?? "document")]
    .filter(Boolean)
    .join(" ");
  return html`<div class="${className}" data-reader-branch="${payload.branch}"><script type="application/json">${jsonScript(payload)}</script></div>`;
}

export function markdownSurface(ctx: WebCtx, rendered: Html, surface: MarkdownSurface = "document"): Html {
  if (ctx.ws.defaultMdFormat === COFLAT_FORMAT_ID) return rendered;
  const className = ["markdown-body", "cf-reader", "cf-doc-surface", "cf-doc-flow", coflatSurfaceClass(surface)]
    .filter(Boolean)
    .join(" ");
  return html`<div class="${className}">${rendered}</div>`;
}
