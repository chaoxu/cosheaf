import type { Hono } from "hono";
import { ROLES, type Role } from "../../shared/roles.js";
import { ForgejoError } from "../forgejo.js";
import type { ForgejoLabel, ForgejoMilestone, ForgejoRepo, ForgejoUser } from "../forgejo-types.js";
import { invalidateWorkspacePermissionCache } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { setWorkspaceMember } from "../workspace-members.js";
import {
  badRequestPage,
  displayLogin,
  htmlResponse,
  notFoundPage,
  redirect,
  repoHref,
  resolveWebRepo,
  resolveWebRepoForAdmin,
  stringField,
  textField,
  type WebCtx,
} from "./web-context.js";
import { html, type Html } from "./web-html.js";
import { labelChip, repoPage } from "./web-page.js";
import { pageShell } from "./web-shell.js";

export function registerSettingsRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepo(c);
  if (!ctx.ok) return ctx.response;
  const isAdmin = ctx.ws.role === "admin";
  const [repo, protection, labels, milestones, collaborators] = await Promise.all([
    ctx.fj.getRepo(ctx.owner, ctx.repo).catch(() => null),
    ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null),
    ctx.fj.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.fj.listMilestones(ctx.owner, ctx.repo, "all").catch(() => []),
    isAdmin ? ctx.fj.listCollaborators(ctx.owner, ctx.repo).catch(() => []) : Promise.resolve([]),
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
      body: html`
        <div class="settings-page">
          <div class="page-title compact">
            <div>
              <p class="eyebrow">Repository</p>
              <h1>Settings</h1>
            </div>
          </div>
          ${repoMetaSection(ctx, repo)}
          <section class="settings-section">
            <div class="settings-section-header">
              <h2>Review policy</h2>
              <p>Main branch protection used before pull requests are merged.</p>
            </div>
            <form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings")}">
              <label class="settings-row">
                <span>Required approvals</span>
                <input name="required_approvals" type="number" min="0" value="${protection?.required_approvals ?? 1}" ${isAdmin ? "" : "disabled"}>
              </label>
              <div class="settings-row">
                <span>Document format</span>
                <strong>${ctx.ws.defaultMdFormat}</strong>
              </div>
              ${isAdmin ? html`<div class="settings-actions"><button class="button primary" type="submit">Save settings</button></div>` : ""}
            </form>
          </section>
          ${labelSettingsSection(ctx, labels)}
          ${milestoneSettingsSection(ctx, milestones)}
          ${accessSection(ctx, collaborators, accessUpdated)}
          ${dangerZoneSection(ctx)}
        </div>
      `,
    }),
  );
});

web.post("/:owner/:repo/settings", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
  const approvals = Number(stringField((await c.req.parseBody()).required_approvals) ?? "1");
  const current = await ctx.fj.getBranchProtection(ctx.owner, ctx.repo, "main");
  if (current) await ctx.fj.updateBranchProtection(ctx.owner, ctx.repo, "main", { required_approvals: approvals });
  else await ctx.fj.createBranchProtection(ctx.owner, ctx.repo, { branch_name: "main", required_approvals: approvals });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/labels", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
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
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const description = textField(form.description) ?? "";
  if (!title) return badRequestPage(ctx.user, "Milestone title is required.");
  await ctx.fj.createMilestone(ctx.owner, ctx.repo, { title, description });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/access", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;

  const body = await c.req.parseBody();
  const username = stringField(body.username)?.trim();
  const role = stringField(body.role)?.trim();
  if (!username || !role || !(ROLES as readonly string[]).includes(role)) {
    return htmlResponse(pageShell({ title: "Bad request", body: html`<main class="auth-page"><p>Invalid access update.</p></main>` }), 400);
  }

  // The caller is repo admin (gated above) — their own PAT carries the
  // collaborator-management rights; no admin token needed.
  await setWorkspaceMember({
    forgejo: ctx.fj,
    owner: ctx.owner,
    repo: ctx.repo,
    username,
    role: role as Role,
  });
  invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`${username} · ${role}`)}`);
});

// Repository metadata: description + visibility (private/public). Forgejo
// PATCH /repos accepts a partial body; we send only the changed fields.
web.post("/:owner/:repo/settings/meta", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
  const form = await c.req.parseBody();
  const description = textField(form.description) ?? "";
  const visibility = stringField(form.visibility);
  await ctx.fj.editRepo(ctx.owner, ctx.repo, {
    description,
    private: visibility === "private" ? true : visibility === "public" ? false : undefined,
  });
  return redirect(repoHref(ctx.owner, ctx.repo, "/settings"));
});

web.post("/:owner/:repo/settings/access/remove", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
  const username = stringField((await c.req.parseBody()).username)?.trim();
  if (!username) return badRequestPage(ctx.user, "Username is required.");
  try {
    await ctx.fj.removeCollaborator(ctx.owner, ctx.repo, username);
  } catch (err) {
    if (!(err instanceof ForgejoError && (err.status === 404 || err.status === 422))) throw err;
  }
  invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
  return redirect(`${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`removed ${username}`)}`);
});

// Repository deletion. Destructive and irreversible, so we re-check admin
// against Forgejo (bypassing the role cache, mirroring requireAdminFresh) and
// require the caller to re-type the full owner/repo name as confirmation.
web.post("/:owner/:repo/settings/delete", async (c) => {
  const ctx = await resolveWebRepoForAdmin(c);
  if (!ctx.ok) return ctx.response;
  const fresh = await ctx.fj.getRepoPermission(ctx.owner, ctx.repo, ctx.user);
  if (fresh !== "admin") return notFoundPage(ctx.user, "Repository not found");
  const confirm = stringField((await c.req.parseBody()).confirm)?.trim();
  if (confirm !== ctx.ws.slug) {
    return badRequestPage(ctx.user, `Type ${ctx.ws.slug} to confirm deletion.`);
  }
  await ctx.fj.deleteRepo(ctx.owner, ctx.repo);
  return redirect("/");
});
}

function labelSettingsSection(ctx: WebCtx, labels: readonly ForgejoLabel[]): Html {
  return html`<section class="settings-section" data-testid="settings-labels">
    <div class="settings-section-header">
      <h2>Labels</h2>
      <p>Labels are repository labels from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="label-chips">${labels.length === 0 ? html`<span class="muted">No labels.</span>` : labels.map(labelChip)}</div>
      ${
        ctx.ws.role === "admin"
          ? html`<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/labels")}">
              <label class="settings-row"><span>Name</span><input name="name" required data-testid="settings-label-name"></label>
              <label class="settings-row"><span>Color</span><input name="color" value="71717a" pattern="[0-9a-fA-F]{6}" required data-testid="settings-label-color"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <label class="settings-row"><span>Exclusive</span><input name="exclusive" type="checkbox" value="on"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-label-submit">Create label</button></div>
            </form>`
          : html`<p class="muted">Only repository admins can create labels.</p>`
      }
    </div>
  </section>`;
}

function milestoneSettingsSection(ctx: WebCtx, milestones: readonly ForgejoMilestone[]): Html {
  return html`<section class="settings-section" data-testid="settings-milestones">
    <div class="settings-section-header">
      <h2>Milestones</h2>
      <p>Milestones are repository milestones from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="list mini-list">
        ${milestones.length === 0
          ? html`<div class="empty">No milestones.</div>`
          : milestones.map((milestone) => html`<div class="list-row"><strong>${milestone.title}</strong><span>${milestone.state} - ${milestone.open_issues} open, ${milestone.closed_issues} closed</span></div>`)}
      </div>
      ${
        ctx.ws.role === "admin"
          ? html`<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/milestones")}">
              <label class="settings-row"><span>Title</span><input name="title" required data-testid="settings-milestone-title"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-milestone-submit">Create milestone</button></div>
            </form>`
          : html`<p class="muted">Only repository admins can create milestones.</p>`
      }
    </div>
  </section>`;
}

function repoMetaSection(ctx: WebCtx, repo: ForgejoRepo | null): Html {
  const description = repo?.description ?? "";
  const isPrivate = repo?.private ?? true;
  const inner = ctx.ws.role === "admin"
    ? html`<form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/meta")}">
        <label class="settings-row"><span>Description</span><input name="description" value="${description}" data-testid="settings-meta-description"></label>
        <label class="settings-row"><span>Visibility</span>
          <select name="visibility" data-testid="settings-meta-visibility">
            <option value="private" ${isPrivate ? "selected" : ""}>Private</option>
            <option value="public" ${isPrivate ? "" : "selected"}>Public</option>
          </select>
        </label>
        <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-meta-submit">Save repository</button></div>
      </form>`
    : html`<div class="settings-form">
        <div class="settings-row"><span>Description</span><strong>${description || "—"}</strong></div>
        <div class="settings-row"><span>Visibility</span><strong>${isPrivate ? "Private" : "Public"}</strong></div>
      </div>`;
  return html`<section class="settings-section" data-testid="settings-meta">
    <div class="settings-section-header"><h2>Repository</h2><p>Description and visibility.</p></div>
    ${inner}
  </section>`;
}

function accessSection(ctx: WebCtx, collaborators: readonly ForgejoUser[], accessUpdated: string | undefined): Html {
  const inner = ctx.ws.role !== "admin"
    ? html`<p class="muted">Only repository admins can manage access.</p>`
    : html`<div class="settings-form" data-testid="settings-collaborators">
      <div class="list mini-list">
        ${collaborators.length === 0
          ? html`<div class="empty">No collaborators.</div>`
          : collaborators.map(
              (member) => html`<div class="list-row">
                <strong>${displayLogin(member.login)}</strong>
                <form method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/access/remove")}">
                  <input type="hidden" name="username" value="${member.login}">
                  <button class="button" type="submit" data-testid="settings-collaborator-remove">Remove</button>
                </form>
              </div>`,
            )}
      </div>
      <form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/access")}" data-testid="settings-access">
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
          ${accessUpdated ? html`<p class="muted" data-testid="settings-access-saved">${accessUpdated}</p>` : ""}
        </div>
      </form>
    </div>`;
  return html`<section class="settings-section">
    <div class="settings-section-header"><h2>Access</h2><p>Grant repository access to users and agents.</p></div>
    ${inner}
  </section>`;
}

function dangerZoneSection(ctx: WebCtx): Html {
  if (ctx.ws.role !== "admin") return html``;
  return html`<section class="settings-section danger-zone" data-testid="settings-danger">
    <div class="settings-section-header">
      <h2>Danger zone</h2>
      <p>Deleting a repository is permanent and removes its files, issues, and pull requests on the forge.</p>
    </div>
    <form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/delete")}"
      onsubmit="return confirm('Permanently delete ${ctx.ws.slug}? This cannot be undone.')">
      <label class="settings-row">
        <span>Type <code>${ctx.ws.slug}</code> to confirm</span>
        <input name="confirm" data-testid="settings-delete-confirm" autocomplete="off" required>
      </label>
      <div class="settings-actions">
        <button class="button danger" type="submit" data-testid="settings-delete-submit">Delete repository</button>
      </div>
    </form>
  </section>`;
}
