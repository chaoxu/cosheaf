import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { requireAuth } from "../middleware.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { normalizeDocumentFormatId } from "../../shared/document-format.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

workspaces.get("/", async (c) => {
  const rows = c
    .get("db")
    .prepare(
      "SELECT id, slug, name, forgejo_repo, default_md_format FROM workspaces ORDER BY name",
    )
    .all() as Array<{
      id: number;
      slug: string;
      name: string;
      forgejo_repo: string;
      default_md_format: string;
    }>;

  // Resolve the caller's role on each workspace via Forgejo using the user's
  // own PAT. Workspaces where the user has no permission are filtered out,
  // mirroring the old behavior where listing was gated by membership.
  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjUser = c.get("user").username;
  const resolved = await Promise.all(
    rows.map(async (r) => {
      const p = await fj.getRepoPermission(owner, r.forgejo_repo, fjUser).catch(() => "none" as const);
      return p === "none"
        ? null
        : {
            id: r.id,
            slug: r.slug,
            name: r.name,
            role: p as Role,
            default_md_format: normalizeDocumentFormatId(r.default_md_format),
          };
    }),
  );
  return c.json({ workspaces: resolved.filter((r): r is NonNullable<typeof r> => r !== null) });
});

workspaces.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: string; name?: string } | null;
  if (!body?.slug || !body.name)
    return c.json({ error: "slug and name required", code: "validation" }, 400);
  if (!WORKSPACE_SLUG_RE.test(body.slug))
    return c.json({ error: "invalid slug", code: "validation" }, 400);

  const db = c.get("db");
  const config = c.get("config");
  // Provisioning creates a repo and installs branch protection + webhooks —
  // operations that need admin privileges. Use the admin-bound client; this
  // is one of the few places that's allowed to.
  const fj = c.get("fjAdmin");
  const user = c.get("user");

  const taken = db.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(body.slug);
  if (taken) return c.json({ error: "slug already taken", code: "conflict" }, 409);

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
        id: workspace.id,
        slug: body.slug,
        name: body.name,
        role: "admin",
        default_md_format: normalizeDocumentFormatId(workspace.default_md_format),
      },
      201,
    );
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE") || (err as Error).message === "workspace slug already exists") {
      return c.json({ error: "slug already taken", code: "conflict" }, 409);
    }
    return c.json(
      { error: `workspace create failed: ${(err as Error).message}`, code: "internal" },
      500,
    );
  }
});
