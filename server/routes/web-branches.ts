import type { Hono } from "hono";
import { validBranchName } from "../branch-path.js";
import { ForgejoError } from "../forgejo.js";
import { onForgejo404 } from "../forgejo-errors.js";
import type { ForgejoBranch } from "../forgejo-types.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { branchIcon } from "./icons.js";
import {
  badRequestPage,
  displayLogin,
  htmlResponse,
  notFoundPage,
  redirect,
  repoHref,
  stringField,
  timeEl,
  urlPath,
  type WebCtx,
  webRoute,
  webRouteForWrite,
} from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { branchOptions, repoPageShell } from "./web-page.js";

export function registerBranchRoutes(web: Hono<AppEnv>): void {
  web.get("/:owner/:repo/branches", webRoute(async (_c, ctx) => {
    const [branches, pulls] = await Promise.all([
      ctx.fj.listBranches(ctx.owner, ctx.repo),
      ctx.fj.listPulls(ctx.owner, ctx.repo, "open").catch(() => []),
    ]);
    const openHeads = new Set(pulls.map((pull) => pull.head.ref));
    return htmlResponse(
      repoPageShell(ctx, "files", `Branches - ${ctx.repo}`, html`
        <div class="page-title compact"><h1>Branches</h1></div>
        ${branchCreatePanel(ctx, branches)}
        ${branchList(ctx, branches, openHeads)}
      `),
    );
  }));

  web.post("/:owner/:repo/branches/new", webRouteForWrite(async (c, ctx) => {
    const form = await c.req.parseBody();
    const name = stringField(form.name);
    const base = stringField(form.base) ?? "main";
    if (!validBranchName(name) || name === "main") return badRequestPage(ctx.user, "Valid non-main branch name is required.");
    if (!validBranchName(base)) return badRequestPage(ctx.user, "Valid base branch is required.");
    try {
      await ctx.fj.createBranch(ctx.owner, ctx.repo, { newBranchName: name, oldBranchName: base });
    } catch (err) {
      if (err instanceof ForgejoError && err.status === 409) {
        return badRequestPage(ctx.user, "Branch already exists.");
      }
      throw err;
    }
    invalidateRepoTrees(ctx.owner, ctx.repo);
    return redirect(`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(name)}`);
  }));

  web.post("/:owner/:repo/branches/delete", webRouteForWrite(async (c, ctx) => {
    const form = await c.req.parseBody();
    const name = stringField(form.name);
    if (!validBranchName(name) || name === "main") return badRequestPage(ctx.user, "Valid non-main branch name is required.");
    try {
      await ctx.fj.deleteBranch(ctx.owner, ctx.repo, name);
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 404)) throw err;
    }
    invalidateRepoTrees(ctx.owner, ctx.repo);
    const redirectTo = branchDeleteRedirect(ctx, stringField(form.redirect_to));
    return redirect(redirectTo);
  }));

  web.get("/:owner/:repo/commits/:sha", webRoute(async (c, ctx) => {
    const sha = c.req.param("sha");
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return notFoundPage(ctx.user, "Commit not found");
    const commit = await ctx.fj.getCommit(ctx.owner, ctx.repo, sha).catch(onForgejo404(null));
    if (!commit) return notFoundPage(ctx.user, "Commit not found");
    return htmlResponse(
      repoPageShell(ctx, "activity", `${commit.sha.slice(0, 10)} - ${ctx.repo}`, html`
        <div class="page-title compact">
          <div>
            <p class="eyebrow">Commit</p>
            <h1>${commit.sha.slice(0, 10)}</h1>
          </div>
        </div>
        <div class="commit-card">
          <pre>${commit.commit.message.trim() || "(no commit message)"}</pre>
          <p>${displayLogin(commit.commit.author?.name ?? commit.author?.login)} - ${timeEl(commit.commit.author?.date)}</p>
          <code>${commit.sha}</code>
        </div>
      `),
    );
  }));
}

function branchDeleteRedirect(ctx: WebCtx, redirectTo: string | null): string {
  const fallback = repoHref(ctx.owner, ctx.repo, "/branches");
  if (!redirectTo) return fallback;
  const repoRoot = repoHref(ctx.owner, ctx.repo);
  return redirectTo === repoRoot || redirectTo.startsWith(`${repoRoot}/`) ? redirectTo : fallback;
}

function branchCreatePanel(ctx: WebCtx, branches: readonly ForgejoBranch[]): Html {
  if (ctx.ws.role === "read") return emptyHtml;
  return html`<form class="filter-panel" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/new")}" data-testid="branch-create-form">
    <label>New branch
      <input name="name" placeholder="user/${ctx.user}/work" required data-testid="branch-create-name">
    </label>
    <label>Base
      <select name="base" data-testid="branch-create-base" data-option-icon="branch">
        ${branchOptions(branches, "main")}
      </select>
    </label>
    <div class="filter-actions">
      <button class="button primary" type="submit">Create branch</button>
    </div>
  </form>`;
}

function branchList(ctx: WebCtx, branches: readonly ForgejoBranch[], openHeads: ReadonlySet<string>): Html {
  if (branches.length === 0) return html`<div class="list"><div class="empty">No branches.</div></div>`;
  return html`<div class="list">${branches.map((branch) => {
    const hasOpenPr = openHeads.has(branch.name);
    return html`<div class="list-row branch-row">
        <a class="inline-link branch-ref" href="${`${repoHref(ctx.owner, ctx.repo, "/src/branch")}/${urlPath(branch.name)}`}">${branchIcon({ size: 13 })}<strong>${branch.name}</strong></a>
        <span>${branch.commit.id.slice(0, 10)}${hasOpenPr ? html` <span class="meta-pill">open PR</span>` : ""}</span>
        ${
          ctx.ws.role === "read" || branch.name === "main" || hasOpenPr
            ? html`<span></span>`
            : html`<form class="inline-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/branches/delete")}">
                <input type="hidden" name="name" value="${branch.name}">
                <button class="button danger" type="submit" data-testid="branch-delete">Delete</button>
              </form>`
        }
      </div>`;
  })}</div>`;
}
