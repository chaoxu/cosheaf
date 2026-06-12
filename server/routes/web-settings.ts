import type { Hono } from "hono";
import { ROLES, type Role } from "../../shared/roles.js";
import type { ForgejoLabel, ForgejoMilestone } from "../forgejo-types.js";
import { invalidateWorkspacePermissionCache } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { setWorkspaceMember } from "../workspace-members.js";
import { escapeHtml } from "./html-escape.js";
import {
  badRequestPage,
  forbiddenPage,
  htmlResponse,
  redirect,
  repoHref,
  resolveWebRepo,
  stringField,
  textField,
  type WebCtx,
} from "./web-context.js";
import { labelChip, repoPage } from "./web-page.js";
import { pageShell } from "./web-shell.js";

export function registerSettingsRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const [protection, labels, milestones] = await Promise.all([
    ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null),
    ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all").catch(() => []),
  ]);
  const accessUpdated = c.req.query("access");
  return htmlResponse(
    repoPage({
      title: `Settings - ${ctx.repo}`,
      owner: ctx.owner,
      repo: ctx.repo,
      active: "settings",
      user: ctx.user,
      ws: ctx.ws,
      body: `
        <div class="settings-page">
          <div class="page-title compact">
            <div>
              <p class="eyebrow">Repository</p>
              <h1>Settings</h1>
            </div>
          </div>
          <section class="settings-section">
            <div class="settings-section-header">
              <h2>Review policy</h2>
              <p>Main branch protection used before pull requests are merged.</p>
            </div>
            <form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings")}">
              <label class="settings-row">
                <span>Required approvals</span>
                <input name="required_approvals" type="number" min="0" value="${protection?.required_approvals ?? 1}" ${ctx.ws.role === "admin" ? "" : "disabled"}>
              </label>
              <div class="settings-row">
                <span>Document format</span>
                <strong>${escapeHtml(ctx.ws.defaultMdFormat)}</strong>
              </div>
              ${ctx.ws.role === "admin" ? `<div class="settings-actions"><button class="button primary" type="submit">Save settings</button></div>` : ""}
            </form>
          </section>
          ${labelSettingsSection(ctx, labels)}
          ${milestoneSettingsSection(ctx, milestones)}
          <section class="settings-section">
            <div class="settings-section-header">
              <h2>Access</h2>
              <p>Grant repository access to users and agents.</p>
            </div>
            ${
              ctx.ws.role === "admin"
                ? `<form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/access")}" data-testid="settings-access">
                    <label class="settings-row">
                      <span>Username</span>
                      <input name="username" data-testid="settings-access-username" required>
                    </label>
                    <label class="settings-row">
                      <span>Role</span>
                      <select name="role" data-testid="settings-access-role">
                        <option value="write">Write</option>
                        <option value="read">Read</option>
                        <option value="admin">Admin</option>
                      </select>
                    </label>
                    <div class="settings-actions">
                      <button class="button primary" type="submit" data-testid="settings-access-submit">Grant access</button>
                      ${accessUpdated ? `<p class="muted" data-testid="settings-access-saved">${escapeHtml(accessUpdated)}</p>` : ""}
                    </div>
                  </form>`
                : `<p class="muted">Only repository admins can grant access.</p>`
            }
          </section>
        </div>
      `,
    }),
  );
});

web.post("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const approvals = Number(stringField((await c.req.parseBody()).required_approvals) ?? "1");
  const current = await ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main");
  if (current) await ctx.fj.updateBranchProtection(ctx.owner, ctx.repo, "main", { required_approvals: approvals });
  else await ctx.fj.createBranchProtection(ctx.owner, ctx.repo, { branch_name: "main", required_approvals: approvals });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/labels", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const name = stringField(form.name);
  const color = (stringField(form.color) ?? "").replace(/^#/, "");
  const description = textField(form.description) ?? "";
  const exclusive = stringField(form.exclusive) === "on";
  if (!name) return badRequestPage(ctx.user, "Label name is required.");
  if (!/^[0-9a-fA-F]{6}$/.test(color)) return badRequestPage(ctx.user, "Label color must be six hex digits.");
  await ctx.fj.createLabel(ctx.owner, ctx.repo, { name, color, description, exclusive });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/milestones", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const description = textField(form.description) ?? "";
  if (!title) return badRequestPage(ctx.user, "Milestone title is required.");
  await ctx.fj.createMilestone(ctx.owner, ctx.repo, { title, description });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/access", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  if (ctx.ws.role !== "admin") return forbiddenPage(ctx.user);

  const body = await c.req.parseBody();
  const username = stringField(body.username)?.trim();
  const role = stringField(body.role)?.trim();
  if (!username || !role || !(ROLES as readonly string[]).includes(role)) {
    return htmlResponse(pageShell({ title: "Bad request", body: `<main class="auth-page"><p>Invalid access update.</p></main>` }), 400);
  }

  await setWorkspaceMember({
    forgejo: c.get("fjAdmin"),
    owner: ctx.owner,
    repo: ctx.repo,
    username,
    role: role as Role,
  });
  invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`${username} · ${role}`)}`);
});
}

function labelSettingsSection(ctx: WebCtx, labels: readonly ForgejoLabel[]): string {
  return `<section class="settings-section" data-testid="settings-labels">
    <div class="settings-section-header">
      <h2>Labels</h2>
      <p>Labels are repository labels from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="label-chips">${labels.map(labelChip).join("") || `<span class="muted">No labels.</span>`}</div>
      ${
        ctx.ws.role === "admin"
          ? `<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/labels")}">
              <label class="settings-row"><span>Name</span><input name="name" required data-testid="settings-label-name"></label>
              <label class="settings-row"><span>Color</span><input name="color" value="71717a" pattern="[0-9a-fA-F]{6}" required data-testid="settings-label-color"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <label class="settings-row"><span>Exclusive</span><input name="exclusive" type="checkbox" value="on"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-label-submit">Create label</button></div>
            </form>`
          : `<p class="muted">Only repository admins can create labels.</p>`
      }
    </div>
  </section>`;
}

function milestoneSettingsSection(ctx: WebCtx, milestones: readonly ForgejoMilestone[]): string {
  return `<section class="settings-section" data-testid="settings-milestones">
    <div class="settings-section-header">
      <h2>Milestones</h2>
      <p>Milestones are repository milestones from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="list mini-list">
        ${milestones
          .map((milestone) => `<div class="list-row"><strong>${escapeHtml(milestone.title)}</strong><span>${escapeHtml(milestone.state)} - ${milestone.open_issues} open, ${milestone.closed_issues} closed</span></div>`)
          .join("") || `<div class="empty">No milestones.</div>`}
      </div>
      ${
        ctx.ws.role === "admin"
          ? `<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/milestones")}">
              <label class="settings-row"><span>Title</span><input name="title" required data-testid="settings-milestone-title"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-milestone-submit">Create milestone</button></div>
            </form>`
          : `<p class="muted">Only repository admins can create milestones.</p>`
      }
    </div>
  </section>`;
}
