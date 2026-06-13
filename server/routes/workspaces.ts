import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { ROLES } from "../../shared/roles.js";
import { FORGEJO_NAME_RE, WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { ForgejoError } from "../forgejo.js";
import { invalidateWorkspacePermissionCache, requireAdminFresh, requireAuth, requireMembership } from "../middleware.js";
import { listVisibleWorkspaceRepos, roleFromPermissions } from "../workspace-discovery.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { setWorkspaceMember } from "../workspace-members.js";
import {
  documentFormatFromTopics,
  isDocumentFormatId,
  normalizeDocumentFormatId,
} from "../../shared/document-format.js";
import { bad, conflict, notFound } from "./responses.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

workspaces.get("/", async (c) => {
  // Workspaces are repos with a `cosheaf-format-*` topic, discovered across
  // ALL owners the caller can see (Forgejo repo search runs under the
  // caller's PAT, so private repos respect Forgejo visibility). Permission
  // resolution and display name come from the same repo objects.
  const fj = c.get("fjUser");

  const repos = await listVisibleWorkspaceRepos(fj);
  // Forgejo's search response includes a `permissions` object on each repo
  // when called with a PAT — derive the role from that instead of a
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
  } | null;
  if (!body?.slug || !body.name)
    return c.json(...bad("slug and name required"));
  if (!WORKSPACE_SLUG_RE.test(body.slug))
    return c.json(...bad("invalid slug"));
  if (body.owner !== undefined && !FORGEJO_NAME_RE.test(body.owner))
    return c.json(...bad("invalid owner"));
  if (body.default_md_format !== undefined && !isDocumentFormatId(body.default_md_format))
    return c.json(...bad("invalid default_md_format"));

  const db = c.get("db");
  const config = c.get("config");
  // Creation runs under the caller's own PAT: repos land in the caller's
  // namespace (or an org they can create in), and the creator's repo-admin
  // rights cover webhook + branch-protection setup. No admin token involved.
  const fj = c.get("fjUser");
  const user = c.get("user");
  const owner = body.owner ?? user.username;

  const existing = await fj.getRepo(owner, body.slug);
  if (existing) return c.json(...conflict("slug already taken"));

  try {
    const { workspace } = await provisionWorkspace(db, fj, config, {
      owner,
      repo: body.slug,
      name: body.name,
      user,
      forgejoUsername: user.username,
      provisionVia: "user-pat",
      rollbackCreatedRepoOnLocalFailure: true,
      defaultMdFormat: body.default_md_format,
    });
    return c.json(
      {
        owner: workspace.owner,
        repo: workspace.repo,
        full_name: workspace.slug,
        name: body.name,
        role: "admin",
        default_md_format: normalizeDocumentFormatId(workspace.defaultMdFormat),
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

members.put("/:owner/:repo/members/:username", requireMembership(), requireAdminFresh, async (c) => {
  const username = c.req.param("username")?.trim();
  if (!username) return c.json(...bad("username required"));

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
