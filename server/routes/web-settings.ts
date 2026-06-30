import type { Hono } from "hono";
import { FORGEJO_NAME_RE } from "../../shared/conventions.js";
import { isFormatTopic } from "../../shared/document-format.js";
import { ROLES, type Role } from "../../shared/roles.js";
import { ForgejoError } from "../forgejo.js";
import { is404 } from "../forgejo-errors.js";
import type { ForgejoBranch, ForgejoLabel, ForgejoMilestone, ForgejoRepo, ForgejoUser } from "../forgejo-types.js";
import { invalidateWorkspaceCaches, invalidateWorkspacePermissionCache, invalidateWorkspaceTitleCache } from "../middleware.js";
import { invalidateRepoTrees } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { deleteSidecarForWorkspace } from "../workspace-cleanup.js";
import { normalizeLabelColor } from "./label-utils.js";
import {
  badRequestPage,
  displayLogin,
  htmlResponse,
  nonNegativeInt,
  notFoundPage,
  positiveInt,
  redirect,
  repoHref,
  stringField,
  textField,
  type WebCtx,
  webRoute,
  webRouteForAdmin,
} from "./web-context.js";
import { type Html, html } from "./web-html.js";
import { addDisclosure, labelChip, repoPageShell } from "./web-page.js";
import { pageShell } from "./web-shell.js";

export function registerSettingsRoutes(web: Hono<AppEnv>): void {
web.get("/:owner/:repo/settings", webRoute(async (c, ctx) => {
  const isAdmin = ctx.ws.role === "admin";
  const [repo, protection, labels, milestones, collaborators, branches] = await Promise.all([
    ctx.collab.getRepo(ctx.owner, ctx.repo).catch(() => null),
    ctx.collab.getBranchProtection(ctx.owner, ctx.repo, "main").catch(() => null),
    ctx.collab.listLabels(ctx.owner, ctx.repo).catch(() => []),
    ctx.collab.listMilestones(ctx.owner, ctx.repo, "all").catch(() => []),
    isAdmin ? ctx.collab.listCollaborators(ctx.owner, ctx.repo).catch(() => []) : Promise.resolve([]),
    isAdmin ? ctx.collab.listBranches(ctx.owner, ctx.repo).catch(() => []) : Promise.resolve([]),
  ]);
  const accessUpdated = c.req.query("access");
  return htmlResponse(
    repoPageShell(ctx, "settings", `Settings - ${ctx.repo}`, html`
        <div class="settings-page">
          <div class="page-title compact">
            <div>
              <h1>Settings</h1>
            </div>
          </div>
          ${repoMetaSection(ctx, repo, branches)}
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
        <script src="/cosheaf-confirm.js" defer></script>
        <script src="/cosheaf-user-autocomplete.js" defer></script>
      `),
  );
}));

web.post("/:owner/:repo/settings", webRouteForAdmin(async (c, ctx) => {
  const approvals = nonNegativeInt(stringField((await c.req.parseBody()).required_approvals));
  if (approvals === null) {
    return badRequestPage(ctx.user, "Required approvals must be a non-negative integer.");
  }
  return runFreshAdminSettingsAction(ctx, async () => {
    const current = await ctx.collab.getBranchProtection(ctx.owner, ctx.repo, "main");
    if (current) await ctx.collab.updateBranchProtection(ctx.owner, ctx.repo, "main", { required_approvals: approvals });
    else await ctx.collab.createBranchProtection(ctx.owner, ctx.repo, { branch_name: "main", required_approvals: approvals });
  });
}));

web.post("/:owner/:repo/settings/labels", webRouteForAdmin(async (c, ctx) => {
  const form = await c.req.parseBody();
  const name = stringField(form.name);
  const color = normalizeLabelColor(stringField(form.color) ?? "");
  const description = textField(form.description) ?? "";
  const exclusive = stringField(form.exclusive) === "on";
  if (!name) return badRequestPage(ctx.user, "Label name is required.");
  if (color === null) return badRequestPage(ctx.user, "Label color must be six hex digits.");
  return runFreshAdminSettingsAction(ctx, () => ctx.collab.createLabel(ctx.owner, ctx.repo, { name, color, description, exclusive }));
}));

web.post("/:owner/:repo/settings/milestones", webRouteForAdmin(async (c, ctx) => {
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  const description = textField(form.description) ?? "";
  if (!title) return badRequestPage(ctx.user, "Milestone title is required.");
  return runFreshAdminSettingsAction(ctx, () => ctx.collab.createMilestone(ctx.owner, ctx.repo, { title, description }));
}));

web.post("/:owner/:repo/settings/labels/:id/edit", webRouteForAdmin(async (c, ctx) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return badRequestPage(ctx.user, "Invalid label.");
  const form = await c.req.parseBody();
  const name = stringField(form.name);
  const color = normalizeLabelColor(stringField(form.color) ?? "");
  if (!name) return badRequestPage(ctx.user, "Label name is required.");
  if (color === null) return badRequestPage(ctx.user, "Label color must be six hex digits.");
  return runFreshAdminSettingsAction(ctx, () =>
    ctx.collab.editLabel(ctx.owner, ctx.repo, id, {
      name,
      color,
      description: textField(form.description) ?? "",
      exclusive: stringField(form.exclusive) === "on",
    }),
  );
}));

web.post("/:owner/:repo/settings/labels/:id/delete", webRouteForAdmin(async (c, ctx) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return badRequestPage(ctx.user, "Invalid label.");
  return runFreshAdminSettingsAction(ctx, async () => {
    try {
      await ctx.collab.deleteLabel(ctx.owner, ctx.repo, id);
    } catch (err) {
      if (!is404(err)) throw err;
    }
  });
}));

web.post("/:owner/:repo/settings/milestones/:id/edit", webRouteForAdmin(async (c, ctx) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return badRequestPage(ctx.user, "Invalid milestone.");
  const form = await c.req.parseBody();
  const title = stringField(form.title);
  if (!title) return badRequestPage(ctx.user, "Milestone title is required.");
  const stateRaw = stringField(form.state);
  return runFreshAdminSettingsAction(ctx, () =>
    ctx.collab.editMilestone(ctx.owner, ctx.repo, id, {
      title,
      description: textField(form.description) ?? "",
      state: stateRaw === "open" || stateRaw === "closed" ? stateRaw : undefined,
    }),
  );
}));

web.post("/:owner/:repo/settings/milestones/:id/delete", webRouteForAdmin(async (c, ctx) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return badRequestPage(ctx.user, "Invalid milestone.");
  return runFreshAdminSettingsAction(ctx, async () => {
    try {
      await ctx.collab.deleteMilestone(ctx.owner, ctx.repo, id);
    } catch (err) {
      if (!is404(err)) throw err;
    }
  });
}));

web.post("/:owner/:repo/settings/access", webRouteForAdmin(async (c, ctx) => {
  const body = await c.req.parseBody();
  const username = stringField(body.username)?.trim();
  const role = stringField(body.role)?.trim();
  if (!username || !FORGEJO_NAME_RE.test(username) || !role || !(ROLES as readonly string[]).includes(role)) {
    return htmlResponse(pageShell({ title: "Bad request", body: html`<main class="auth-page"><p>Invalid access update.</p></main>` }), 400);
  }
  return runFreshAdminSettingsAction(
    ctx,
    async () => {
      // The caller is repo admin (gated above). Hosted runs setWorkspaceMember
      // against the forge; local proxies to the connected core's members route.
      await ctx.setMember(username, role as Role);
      invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
    },
    `${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`${username} · ${role}`)}`,
  );
}));

// Repository metadata: description + visibility (private/public). Forgejo
// PATCH /repos accepts a partial body; we send only the changed fields.
web.post("/:owner/:repo/settings/meta", webRouteForAdmin(async (c, ctx) => {
  const form = await c.req.parseBody();
  const description = textField(form.description) ?? "";
  const visibility = stringField(form.visibility);
  const defaultBranch = stringField(form.default_branch) ?? undefined;
  return runFreshAdminSettingsAction(ctx, async () => {
    await ctx.collab.editRepo(ctx.owner, ctx.repo, {
      description,
      private: visibility === "private" ? true : visibility === "public" ? false : undefined,
      default_branch: defaultBranch,
    });
    invalidateWorkspaceTitleCache(ctx.owner, ctx.repo);
    // Topics: the user edits only the free topics; the cosheaf-format-* topic is
    // managed by the document format and must survive a topics edit.
    if (form.topics !== undefined) {
      const existing = await ctx.collab.listRepoTopics(ctx.owner, ctx.repo).catch(() => []);
      await ctx.collab.replaceRepoTopics(ctx.owner, ctx.repo, mergeRepoTopics(existing, stringField(form.topics) ?? ""));
    }
  });
}));

web.post("/:owner/:repo/settings/access/remove", webRouteForAdmin(async (c, ctx) => {
  const username = stringField((await c.req.parseBody()).username)?.trim();
  if (!username) return badRequestPage(ctx.user, "Username is required.");
  if (!FORGEJO_NAME_RE.test(username)) return badRequestPage(ctx.user, "Invalid username.");
  return runFreshAdminSettingsAction(
    ctx,
    async () => {
      try {
        await ctx.collab.removeCollaborator(ctx.owner, ctx.repo, username);
      } catch (err) {
        if (!(err instanceof ForgejoError && (err.status === 404 || err.status === 422))) throw err;
      }
      invalidateWorkspacePermissionCache(ctx.owner, ctx.repo, username);
    },
    `${repoHref(ctx.owner, ctx.repo, "/settings")}?access=${encodeURIComponent(`removed ${username}`)}`,
  );
}));

// Repository deletion. Destructive and irreversible, so we re-check admin
// against Forgejo (bypassing the role cache, mirroring requireAdminFresh) and
// require the caller to re-type the full owner/repo name as confirmation.
web.post("/:owner/:repo/settings/delete", webRouteForAdmin(async (c, ctx) => {
  const confirm = stringField((await c.req.parseBody()).confirm)?.trim();
  if (confirm !== ctx.ws.slug) {
    return badRequestPage(ctx.user, `Type ${ctx.ws.slug} to confirm deletion.`);
  }
  // Local Workbench: no forge client; the core owns the repo and enforces admin
  // on the proxied delete. Hosted re-checks fresh against the forge.
  const fresh = ctx.writeMode === "direct" ? ctx.ws.role : await ctx.fj.getRepoPermission(ctx.owner, ctx.repo, ctx.user);
  if (fresh !== "admin") {
    const gone = fresh === "none" && !(await c.get("fjAdmin").getRepo(ctx.owner, ctx.repo));
    if (!gone) return notFoundPage(ctx.user, "Repository not found");
    cleanupDeletedWorkspace(ctx);
    return redirect("/");
  }
  try {
    await ctx.collab.deleteRepo(ctx.owner, ctx.repo);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) throw err;
  }
  cleanupDeletedWorkspace(ctx);
  return redirect("/");
}));
}

async function requireFreshAdminPage(ctx: WebCtx): Promise<Response | null> {
  // Local Workbench (writeMode "direct") has no forge client; the local user is
  // admin on their own folder and the connected core enforces admin on the real
  // write. Hosted does a fresh forge re-check (mirroring requireAdminFresh).
  const fresh = ctx.writeMode === "direct" ? ctx.ws.role : await ctx.fj.getRepoPermission(ctx.owner, ctx.repo, ctx.user);
  if (fresh !== "admin") return notFoundPage(ctx.user, "Repository not found");
  return null;
}

async function runFreshAdminSettingsAction(
  ctx: WebCtx,
  action: () => Promise<unknown>,
  redirectTo = repoHref(ctx.owner, ctx.repo, "/settings"),
): Promise<Response> {
  const freshAdmin = await requireFreshAdminPage(ctx);
  if (freshAdmin) return freshAdmin;
  await action();
  return redirect(redirectTo);
}

function cleanupDeletedWorkspace(ctx: WebCtx): void {
  deleteSidecarForWorkspace(ctx.db, ctx.ws.slug);
  invalidateRepoTrees(ctx.owner, ctx.repo);
  invalidateWorkspaceCaches(ctx.owner, ctx.repo);
}

function labelRow(ctx: WebCtx, label: ForgejoLabel): Html {
  if (ctx.ws.role !== "admin") return html`<div class="list-row">${labelChip(label)}</div>`;
  const base = repoHref(ctx.owner, ctx.repo, `/settings/labels/${label.id}`);
  return html`<div class="list-row" data-testid="settings-label-row">
    ${labelChip(label)}
    <details class="inline-edit">
      <summary>Edit</summary>
      <form class="settings-form compact-form" method="post" action="${base}/edit">
        <label class="settings-row"><span>Name</span><input name="name" value="${label.name}" required></label>
        <label class="settings-row"><span>Color</span><input name="color" value="${label.color}" pattern="[0-9a-fA-F]{6}" required></label>
        <label class="settings-row"><span>Description</span><input name="description" value="${label.description ?? ""}"></label>
        <label class="settings-row"><span>Exclusive</span><input name="exclusive" type="checkbox" value="on" ${label.exclusive ? "checked" : ""}></label>
        <div class="settings-actions"><button class="button primary" type="submit">Save</button></div>
      </form>
    </details>
    <form method="post" action="${base}/delete" data-confirm="Delete label ${label.name}?">
      <button class="button danger" type="submit" data-testid="settings-label-delete">Delete</button>
    </form>
  </div>`;
}

function labelSettingsSection(ctx: WebCtx, labels: readonly ForgejoLabel[]): Html {
  return html`<section class="settings-section" data-testid="settings-labels">
    <div class="settings-section-header">
      <h2>Labels</h2>
      <p>Labels are repository labels from Forgejo.</p>
    </div>
    <div class="settings-form">
      <div class="list mini-list">${labels.length === 0 ? html`<div class="empty">No labels.</div>` : labels.map((label) => labelRow(ctx, label))}</div>
      ${
        ctx.ws.role === "admin"
          ? addDisclosure("New label", html`<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/labels")}">
              <label class="settings-row"><span>Name</span><input name="name" required data-testid="settings-label-name"></label>
              <label class="settings-row"><span>Color</span><input name="color" value="71717a" pattern="[0-9a-fA-F]{6}" required data-testid="settings-label-color"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <label class="settings-row"><span>Exclusive</span><input name="exclusive" type="checkbox" value="on"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-label-submit">Create label</button></div>
            </form>`)
          : html`<p class="muted">Only repository admins can create labels.</p>`
      }
    </div>
  </section>`;
}

function milestoneRow(ctx: WebCtx, milestone: ForgejoMilestone): Html {
  const meta = html`<strong>${milestone.title}</strong><span>${milestone.state} - ${milestone.open_issues} open, ${milestone.closed_issues} closed</span>`;
  if (ctx.ws.role !== "admin") return html`<div class="list-row">${meta}</div>`;
  const base = repoHref(ctx.owner, ctx.repo, `/settings/milestones/${milestone.id}`);
  const nextState = milestone.state === "open" ? "closed" : "open";
  return html`<div class="list-row" data-testid="settings-milestone-row">
    ${meta}
    <details class="inline-edit">
      <summary>Edit</summary>
      <form class="settings-form compact-form" method="post" action="${base}/edit">
        <label class="settings-row"><span>Title</span><input name="title" value="${milestone.title}" required></label>
        <label class="settings-row"><span>Description</span><input name="description" value="${milestone.description ?? ""}"></label>
        <input type="hidden" name="state" value="${milestone.state}">
        <div class="settings-actions"><button class="button primary" type="submit">Save</button></div>
      </form>
    </details>
    <form method="post" action="${base}/edit">
      <input type="hidden" name="title" value="${milestone.title}">
      <input type="hidden" name="description" value="${milestone.description ?? ""}">
      <input type="hidden" name="state" value="${nextState}">
      <button class="button" type="submit" data-testid="settings-milestone-toggle">${milestone.state === "open" ? "Close" : "Reopen"}</button>
    </form>
    <form method="post" action="${base}/delete" data-confirm="Delete milestone ${milestone.title}?">
      <button class="button danger" type="submit" data-testid="settings-milestone-delete">Delete</button>
    </form>
  </div>`;
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
          : milestones.map((milestone) => milestoneRow(ctx, milestone))}
      </div>
      ${
        ctx.ws.role === "admin"
          ? addDisclosure("New milestone", html`<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/milestones")}">
              <label class="settings-row"><span>Title</span><input name="title" required data-testid="settings-milestone-title"></label>
              <label class="settings-row"><span>Description</span><input name="description"></label>
              <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-milestone-submit">Create milestone</button></div>
            </form>`)
          : html`<p class="muted">Only repository admins can create milestones.</p>`
      }
    </div>
  </section>`;
}

// The cosheaf-format-* topic is managed via the document format, not the free
// topics field, so we hide it from the editable list and preserve it on save.
function editableTopics(topics: readonly string[] | undefined): string {
  return (topics ?? []).filter((t) => !isFormatTopic(t)).join(" ");
}

// Merge a free-text topics input back with the existing topics for a save: the
// format topic(s) are preserved (the user can't edit them away here), the
// entered topics are normalized (lowercased, validated to Forgejo's topic
// shape, format topics stripped), and the result is deduped.
export function mergeRepoTopics(existing: readonly string[], enteredRaw: string): string[] {
  const preservedFormat = existing.filter(isFormatTopic);
  const entered = enteredRaw
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t) && !isFormatTopic(t));
  return [...new Set([...preservedFormat, ...entered])];
}

function repoMetaSection(ctx: WebCtx, repo: ForgejoRepo | null, branches: readonly ForgejoBranch[]): Html {
  const description = repo?.description ?? "";
  const isPrivate = repo?.private ?? true;
  const defaultBranch = repo?.default_branch ?? "main";
  const topics = editableTopics(repo?.topics);
  const branchOpts = branches.length
    ? branches
    : [{ name: defaultBranch } as ForgejoBranch];
  const inner = ctx.ws.role === "admin"
    ? html`<form class="settings-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/meta")}">
        <label class="settings-row"><span>Description</span><input name="description" value="${description}" data-testid="settings-meta-description"></label>
        <label class="settings-row"><span>Visibility</span>
          <select name="visibility" data-testid="settings-meta-visibility">
            <option value="private" ${isPrivate ? "selected" : ""}>Private</option>
            <option value="public" ${isPrivate ? "" : "selected"}>Public</option>
          </select>
        </label>
        <label class="settings-row"><span>Default branch</span>
          <select name="default_branch" data-testid="settings-meta-default-branch">
            ${branchOpts.map((b) => html`<option value="${b.name}" ${b.name === defaultBranch ? "selected" : ""}>${b.name}</option>`)}
          </select>
        </label>
        <label class="settings-row"><span>Topics</span><input name="topics" value="${topics}" placeholder="space-separated" data-testid="settings-meta-topics"></label>
        <div class="settings-actions"><button class="button primary" type="submit" data-testid="settings-meta-submit">Save repository</button></div>
      </form>`
    : html`<div class="settings-form">
        <div class="settings-row"><span>Description</span><strong>${description || "—"}</strong></div>
        <div class="settings-row"><span>Visibility</span><strong>${isPrivate ? "Private" : "Public"}</strong></div>
        <div class="settings-row"><span>Default branch</span><strong>${defaultBranch}</strong></div>
        <div class="settings-row"><span>Topics</span><strong>${topics || "—"}</strong></div>
      </div>`;
  return html`<section class="settings-section" data-testid="settings-meta">
    <div class="settings-section-header"><h2>Repository</h2><p>Description, visibility, default branch, and topics.</p></div>
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
                  <button class="button danger" type="submit" data-testid="settings-collaborator-remove">Remove</button>
                </form>
              </div>`,
            )}
      </div>
      ${addDisclosure("Add collaborator", html`<form class="settings-form compact-form" method="post" action="${repoHref(ctx.owner, ctx.repo, "/settings/access")}" data-testid="settings-access">
        <label class="settings-row">
          <span>Username</span>
          <input name="username" data-testid="settings-access-username" autocomplete="off" list="settings-access-usernames" data-user-autocomplete="${repoHref(ctx.owner, ctx.repo, "/user-suggestions")}" required>
          <datalist id="settings-access-usernames"></datalist>
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
      </form>`)}
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
      data-confirm="Permanently delete ${ctx.ws.slug}? This cannot be undone.">
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
