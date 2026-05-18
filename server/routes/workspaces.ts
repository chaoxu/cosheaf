import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { requireAuth } from "../middleware.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import {
  documentFormatFromTopics,
  isFormatTopic,
  normalizeDocumentFormatId,
} from "../../shared/document-format.js";
import { bad, conflict } from "./responses.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

workspaces.get("/", async (c) => {
  // Cosheaf workspaces are now identified by the presence of a
  // `cosheaf-format-*` topic on a repo under config.forgejoOwner. We list
  // those repos via Forgejo (the source of truth) and filter by the topic
  // marker. Permission resolution and display name come from the same
  // repo objects.
  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjUser = c.get("user").username;

  const repos = await fj.listUserRepos(owner, { limit: 50 });
  const candidates = repos.filter((r) => (r.topics ?? []).some(isFormatTopic));
  const resolved = await Promise.all(
    candidates.map(async (r) => {
      const role = await fj.getRepoPermission(owner, r.name, fjUser).catch(() => "none" as const);
      if (role === "none") return null;
      return {
        slug: r.name,
        name: r.description?.trim() || r.name,
        role: role as Role,
        default_md_format: documentFormatFromTopics(r.topics ?? []),
      };
    }),
  );
  return c.json({ workspaces: resolved.filter((r): r is NonNullable<typeof r> => r !== null) });
});

workspaces.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: string; name?: string } | null;
  if (!body?.slug || !body.name)
    return c.json(...bad("slug and name required"));
  if (!WORKSPACE_SLUG_RE.test(body.slug))
    return c.json(...bad("invalid slug"));

  const db = c.get("db");
  const config = c.get("config");
  // Provisioning creates a repo and installs branch protection + webhooks —
  // operations that need admin privileges. Use the admin-bound client; this
  // is one of the few places that's allowed to.
  const fj = c.get("fjAdmin");
  const user = c.get("user");

  const existing = await fj.getRepo(config.forgejoOwner, body.slug);
  if (existing) return c.json(...conflict("slug already taken"));

  try {
    const { workspace } = await provisionWorkspace(db, fj, config, {
      slug: body.slug,
      name: body.name,
      user,
      forgejoUsername: user.username,
      rollbackCreatedRepoOnLocalFailure: true,
    });
    return c.json(
      {
        slug: workspace.slug,
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
