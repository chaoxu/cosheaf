import { Hono } from "hono";
import { FORGEJO_NAME_RE, WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import {
  documentFormatFromTopics,
  isDocumentFormatId,
  normalizeDocumentFormatId,
} from "../../shared/document-format.js";
import type { Role } from "../../shared/roles.js";
import { ROLES } from "../../shared/roles.js";
import { ForgejoError, type ForgejoRepo } from "../forgejo.js";
import { invalidateWorkspacePermissionCache, repoCtxForgejo, requireAdminFresh, requireAuth, requireMembership } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { listVisibleWorkspaceRepos, roleFromPermissions } from "../workspace-discovery.js";
import { setWorkspaceMember } from "../workspace-members.js";
import { provisionWorkspace, type WorkspaceVisibility } from "../workspace-provisioning.js";
import { bad, conflict, notFound } from "./responses.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

function parseVisibility(value: unknown): WorkspaceVisibility | null {
  if (value === undefined) return "private";
  if (value === "private" || value === "public") return value;
  return null;
}

function parseRequiredApprovals(value: unknown): number | null {
  if (value === undefined) return 1;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

workspaces.get("/", async (c) => {
  // Workspaces are all repos the caller can see. Forgejo repo search runs under
  // the user's resolved backend credential, so private repos respect Forgejo
  // visibility. Permission resolution and display name come from the same repo
  // objects; markdown format resolution is Coflat-only.
  const fj = c.get("fjUser");

  const repos = await listVisibleWorkspaceRepos(fj);
  // Forgejo's search response includes a `permissions` object on each repo
  // for the authenticated backend credential — derive the role from that
  // instead of a
  // per-repo getRepoPermission round-trip.
  const workspaces = repos
    .map((r) => ({ repo: r, role: roleFromPermissions(r.permissions) }))
    .filter((x) => x.role !== "none")
    .map(({ repo: r, role }) => ({
      owner: r.owner.login,
      repo: r.name,
      full_name: r.full_name,
      name: r.description?.trim() || r.name,
      role: role as Role,
      default_md_format: documentFormatFromTopics(r.topics ?? []),
    }));
  return c.json({ workspaces });
});

workspaces.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    owner?: string;
    slug?: string;
    name?: string;
    default_md_format?: string;
    visibility?: unknown;
    required_approvals?: unknown;
  } | null;
  const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const owner = body?.owner === undefined ? undefined : typeof body.owner === "string" ? body.owner.trim() : null;
  const defaultMdFormat = body?.default_md_format;
  const visibility = parseVisibility(body?.visibility);
  const requiredApprovals = parseRequiredApprovals(body?.required_approvals);
  if (!slug || !name)
    return c.json(...bad("slug and name required"));
  if (!WORKSPACE_SLUG_RE.test(slug))
    return c.json(...bad("invalid slug"));
  if (owner !== undefined && (!owner || !FORGEJO_NAME_RE.test(owner)))
    return c.json(...bad("invalid owner"));
  if (defaultMdFormat !== undefined && !isDocumentFormatId(defaultMdFormat))
    return c.json(...bad("invalid default_md_format"));
  if (visibility === null)
    return c.json(...bad("invalid visibility"));
  if (requiredApprovals === null)
    return c.json(...bad("required_approvals must be a non-negative integer"));

  const db = c.get("db");
  const config = c.get("config");
  // Creation runs under the caller's own PAT: repos land in the caller's
  // namespace (or an org they can create in), and the creator's repo-admin
  // rights cover webhook + branch-protection setup. No admin token involved.
  const fj = c.get("fjUser");
  const user = c.get("user");
  const workspaceOwner = owner ?? user.username;

  const existing = await fj.getRepo(workspaceOwner, slug);
  if (existing) return c.json(...conflict("slug already taken"));

  try {
    const { workspace } = await provisionWorkspace(db, fj, config, {
      owner: workspaceOwner,
      repo: slug,
      name,
      user,
      forgejoUsername: user.username,
      provisionVia: "user-pat",
      rollbackCreatedRepoOnLocalFailure: true,
      defaultMdFormat,
      visibility,
      requiredApprovals,
    });
    return c.json(
      {
        owner: workspace.owner,
        repo: workspace.repo,
        full_name: workspace.slug,
        name,
        role: "admin",
        default_md_format: normalizeDocumentFormatId(workspace.defaultMdFormat),
        visibility,
        required_approvals: requiredApprovals,
      },
      201,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE") || (err as Error).message === "workspace slug already exists") {
      return c.json(...conflict("slug already taken"));
    }
    return c.json(
      { error: `workspace create failed: ${(err as Error).message}`, code: "internal" },
      500,
    );
  }
});

// Mounted under /api/v1/repos alongside the other typed workspace routes.
export const members = new Hono<AppEnv>();
members.use("*", requireAuth);

function publicRepoShape(c: import("hono").Context<AppEnv>, repoMeta: ForgejoRepo): Record<string, unknown> {
  const { owner, repo } = c.get("repoCtx");
  const origin = new URL(c.req.url).origin;
  const apiRepo = `${origin}/api/v1/repos/${owner}/${repo}`;
  const webRepo = `${origin}/${owner}/${repo}`;
  return {
    ...repoMeta,
    full_name: repoMeta.full_name || `${owner}/${repo}`,
    name: repoMeta.name || repo,
    owner: {
      id: repoMeta.owner?.id ?? 0,
      login: repoMeta.owner?.login ?? owner,
      login_name: repoMeta.owner?.login ?? owner,
      username: repoMeta.owner?.login ?? owner,
      full_name: repoMeta.owner?.full_name ?? "",
      email: "",
      avatar_url: "",
      html_url: `${origin}/${owner}`,
    },
    url: apiRepo,
    html_url: webRepo,
    link: webRepo,
    languages_url: `${apiRepo}/languages`,
    clone_url: "",
    ssh_url: "",
    original_url: "",
    wiki_ssh_url: "",
    wiki_clone_url: "",
  };
}

members.get("/:owner/:repo", requireMembership(), async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const found = await fj.getRepo(owner, repo);
  if (!found) return c.json(...notFound("workspace not found"));
  return c.json(publicRepoShape(c, found));
});

// Patch repo metadata (the settings meta form: description + visibility +
// default branch). Admin-only and fresh-checked, mirroring the destructive
// settings surface. Forgejo PATCH accepts a partial body, so only the fields the
// caller set are forwarded; the response is the same forge-repo-compatible shape
// GET /:owner/:repo returns.
members.patch("/:owner/:repo", requireMembership(), requireAdminFresh, async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  const body = (await c.req.json().catch(() => null)) as {
    description?: unknown;
    private?: unknown;
    default_branch?: unknown;
  } | null;
  if (!body || typeof body !== "object") return c.json(...bad("body required"));
  const patch: { description?: string; private?: boolean; default_branch?: string } = {};
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return c.json(...bad("description must be a string"));
    patch.description = body.description;
  }
  if (body.private !== undefined) {
    if (typeof body.private !== "boolean") return c.json(...bad("private must be a boolean"));
    patch.private = body.private;
  }
  if (body.default_branch !== undefined) {
    if (typeof body.default_branch !== "string" || !body.default_branch.trim())
      return c.json(...bad("default_branch must be a non-empty string"));
    patch.default_branch = body.default_branch;
  }
  const updated = await fj.editRepo(owner, repo, patch);
  return c.json(publicRepoShape(c, updated));
});

// Delete the repo. Admin-only and fresh-checked. Idempotent: a 404 means the
// repo is already gone, matching the hosted settings-delete swallow.
members.delete("/:owner/:repo", requireMembership(), requireAdminFresh, async (c) => {
  const { fj, owner, repo } = repoCtxForgejo(c);
  try {
    await fj.deleteRepo(owner, repo);
  } catch (err) {
    if (!(err instanceof ForgejoError && err.status === 404)) throw err;
  }
  return c.json({ ok: true });
});

members.put("/:owner/:repo/members/:username", requireMembership(), requireAdminFresh, async (c) => {
  const username = c.req.param("username")?.trim();
  if (!username) return c.json(...bad("username required"));
  if (!FORGEJO_NAME_RE.test(username)) return c.json(...bad("invalid username"));

  const body = (await c.req.json().catch(() => null)) as { role?: string } | null;
  if (!body?.role || !(ROLES as readonly string[]).includes(body.role))
    return c.json(...bad(`role must be ${ROLES.join("|")}`));

  const role = body.role as Role;
  const ws = c.get("workspace");
  // The caller passed requireAdminFresh — their own PAT carries repo-admin
  // rights, which is exactly what collaborator management needs.
  const fj = c.get("fjUser");

  try {
    await setWorkspaceMember({
      forgejo: fj,
      owner: ws.owner,
      repo: ws.repo,
      username,
      role,
    });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404) {
      return c.json(...notFound("user or workspace not found"));
    }
    throw err;
  }

  invalidateWorkspacePermissionCache(ws.owner, ws.repo, username);
  return c.json({ ok: true, username, role });
});

members.delete("/:owner/:repo/members/:username", requireMembership(), requireAdminFresh, async (c) => {
  const username = c.req.param("username")?.trim();
  if (!username) return c.json(...bad("username required"));
  if (!FORGEJO_NAME_RE.test(username)) return c.json(...bad("invalid username"));

  const ws = c.get("workspace");
  // The caller passed requireAdminFresh — their own PAT carries the
  // collaborator-management rights. Removing is idempotent: a 404/422 means the
  // user is already gone, mirroring the hosted web-settings remove path.
  const fj = c.get("fjUser");
  try {
    await fj.removeCollaborator(ws.owner, ws.repo, username);
  } catch (err) {
    if (!(err instanceof ForgejoError && (err.status === 404 || err.status === 422))) throw err;
  }

  invalidateWorkspacePermissionCache(ws.owner, ws.repo, username);
  return c.json({ ok: true, username });
});
