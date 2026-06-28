import { LATEX_CSL_NAMES, LATEX_TEMPLATE_NAMES } from "@chaoxu/coflat/latex";
import type { Context, Hono } from "hono";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { resolveBranchPath } from "../branch-path.js";
import { onWorkspaceNotFound, type WorkspaceBackend } from "../workspace-backend.js";
import type { ForgejoTreeEntry } from "../forgejo-types.js";
import { exportCoflatMarkdownPdf, PdfExportError, type PdfProjectFile, withPdfExportLimit } from "../pdf-export.js";
import { loadRepoConfig } from "../repo-config.js";
import type { AppEnv } from "../types.js";
import { safeRel } from "./files.js";
import { badRequestPage, clientIp, htmlResponse, notFoundPage, repoHref, routeRest, urlPath, webRoute } from "./web-context.js";
import { html } from "./web-html.js";
import { repoPageShell } from "./web-page.js";

const PDF_EXPORT_MAX_FILES = 500;
const PDF_EXPORT_MAX_PROJECT_BYTES = 100 * 1024 * 1024;

export function registerPdfExportRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/export/pdf/options/branch/*", webRoute(async (c, ctx) => {
    if (ctx.ws.defaultMdFormat !== COFLAT_FORMAT_ID) {
      return badRequestPage(ctx.user, "PDF export is only available for Coflat Markdown workspaces.");
    }
    const resolved = await resolveBranchPath(ctx.backend, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/export/pdf/options/branch/"));
    if (!resolved?.path) return notFoundPage(ctx.user, "File not found");
    const rel = safeRel(resolved.path);
    if (!rel || fileKindForPath(rel) !== "markdown") {
      return badRequestPage(ctx.user, "PDF export is only available for Markdown files.");
    }
    const meta = await ctx.backend.getFileMeta(ctx.owner, ctx.repo, resolved.branch, rel).catch(onWorkspaceNotFound(null));
    if (!meta) return notFoundPage(ctx.user, "File not found");
    const repoConfig = await loadRepoConfig(ctx.db, ctx.backend, ctx.owner, ctx.repo, resolved.branch);
    return htmlResponse(
      repoPageShell(ctx, "files", `PDF export - ${rel}`, html`
        <div class="page-title compact">
          <div>
            <h1>PDF Export</h1>
            <p class="muted">${rel} on ${resolved.branch}</p>
          </div>
        </div>
        <section class="settings-section" data-testid="pdf-export-options">
          <div class="settings-section-header">
            <h2>Options</h2>
            <p>Defaults come from cosheaf.yaml and can be overridden for this export.</p>
          </div>
          <form class="settings-form" method="get" action="${pdfExportHref(ctx.owner, ctx.repo, resolved.branch, rel)}">
            <label class="settings-row">
              <span>Bibliography</span>
              <input name="bibliography" placeholder="${repoConfig.pdfBibliography ?? "refs.bib"}">
            </label>
            <label class="settings-row">
              <span>CSL</span>
              <input name="csl" list="pdf-csl-options" placeholder="${repoConfig.pdfCsl ?? "ieee"}">
            </label>
            <datalist id="pdf-csl-options">${[...LATEX_CSL_NAMES].sort().map((name) => html`<option value="${name}"></option>`)}</datalist>
            <label class="settings-row">
              <span>Template</span>
              <input name="template" list="pdf-template-options" placeholder="${repoConfig.pdfTemplate ?? "article"}">
            </label>
            <datalist id="pdf-template-options">${[...LATEX_TEMPLATE_NAMES].sort().map((name) => html`<option value="${name}"></option>`)}</datalist>
            <div class="settings-actions">
              <button class="button primary" type="submit">Export PDF</button>
              <a class="button subtle" href="${readHref(ctx.owner, ctx.repo, resolved.branch, rel)}">Cancel</a>
            </div>
          </form>
        </section>
      `),
    );
  }));

  web.get("/:owner/:repo/export/pdf/branch/*", webRoute(async (c, ctx) => {
    if (ctx.ws.defaultMdFormat !== COFLAT_FORMAT_ID) {
      return new Response("PDF export is only available for Coflat Markdown workspaces.", { status: 400 });
    }
    try {
      const result = await withPdfExportLimit(`${ctx.user}:${clientIp(c, c.get("config").trustedProxyHops)}`, async () => {
        const resolved = await resolveBranchPath(ctx.backend, ctx.owner, ctx.repo, routeRest(c, ctx.owner, ctx.repo, "/export/pdf/branch/"));
        if (!resolved?.path) throw new PdfExportError(404, "not found");
        const rel = safeRel(resolved.path);
        if (!rel) throw new PdfExportError(404, "not found");
        if (fileKindForPath(rel) !== "markdown") {
          throw new PdfExportError(400, "PDF export is only available for Markdown files.");
        }
        const meta = await ctx.backend.getFileMeta(ctx.owner, ctx.repo, resolved.branch, rel).catch(onWorkspaceNotFound(null));
        if (!meta) throw new PdfExportError(404, "not found");

        const [source, files] = await Promise.all([
          ctx.backend.getRawFile(ctx.owner, ctx.repo, resolved.branch, rel),
          repoFiles(ctx.backend, ctx.owner, ctx.repo, resolved.branch),
        ]);
        const repoConfig = await loadRepoConfig(ctx.db, ctx.backend, ctx.owner, ctx.repo, resolved.branch);
        const projectFiles = await collectPdfProjectFiles(ctx.backend, ctx.owner, ctx.repo, resolved.branch, rel, source, files);
        return exportCoflatMarkdownPdf({
          source,
          sourcePath: rel,
          files: projectFiles,
          defaults: {
            bibliography: repoConfig.pdfBibliography,
            csl: repoConfig.pdfCsl,
            template: repoConfig.pdfTemplate,
          },
          flags: {
            bibliography: queryOverride(c, "bibliography"),
            csl: queryOverride(c, "csl"),
            template: queryOverride(c, "template"),
          },
        });
      });
      return new Response(result.pdf, {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${httpQuotedString(result.filename)}"`,
          "content-type": "application/pdf",
        },
      });
    } catch (error) {
      if (error instanceof PdfExportError) {
        return new Response(error.detail ? `${error.publicMessage}\n${error.detail}` : error.publicMessage, {
          status: error.status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      throw error;
    }
  }));
}

async function repoFiles(backend: WorkspaceBackend, owner: string, repo: string, ref: string) {
  const tree = await backend.getTree(owner, repo, ref, true);
  return tree
    .filter((entry) => entry.type === "blob")
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function collectPdfProjectFiles(
  backend: WorkspaceBackend,
  owner: string,
  repo: string,
  branch: string,
  sourceRel: string,
  source: string,
  files: readonly ForgejoTreeEntry[],
): Promise<PdfProjectFile[]> {
  if (files.length > PDF_EXPORT_MAX_FILES) {
    throw new PdfExportError(413, `PDF export is limited to ${PDF_EXPORT_MAX_FILES} repository files.`);
  }
  const out: PdfProjectFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const rel = safeRel(file.path);
    if (!rel) continue;
    if (typeof file.size === "number" && totalBytes + file.size > PDF_EXPORT_MAX_PROJECT_BYTES) {
      throw new PdfExportError(413, "PDF export project files are too large.");
    }
    const content = rel === sourceRel
      ? Buffer.from(source, "utf8")
      : await backend.getRawFileBytes(owner, repo, branch, rel);
    totalBytes += content.byteLength;
    if (totalBytes > PDF_EXPORT_MAX_PROJECT_BYTES) {
      throw new PdfExportError(413, "PDF export project files are too large.");
    }
    out.push({ path: rel, content });
  }
  if (!out.some((file) => file.path === sourceRel)) {
    const content = Buffer.from(source, "utf8");
    totalBytes += content.byteLength;
    if (totalBytes > PDF_EXPORT_MAX_PROJECT_BYTES) {
      throw new PdfExportError(413, "PDF export project files are too large.");
    }
    out.push({ path: sourceRel, content });
  }
  return out;
}

function queryOverride(c: Context<AppEnv>, key: string): string | undefined {
  const value = c.req.query(key)?.trim();
  return value ? value : undefined;
}

function readHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

function pdfExportHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/export/pdf/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

export function pdfExportOptionsHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/export/pdf/options/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

function httpQuotedString(value: string): string {
  return value.replaceAll(/["\\\r\n]/g, "_");
}
