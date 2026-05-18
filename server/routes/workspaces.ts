import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { Role } from "../../shared/roles.js";
import { WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { requireAuth } from "../middleware.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { normalizeDocumentFormatId } from "../../shared/document-format.js";
import { bad, conflict } from "./responses.js";

export const workspaces = new Hono<AppEnv>();
workspaces.use("*", requireAuth);

workspaces.get("/", async (c) => {
  const rows = c
    .get("db")
    .prepare(
      "SELECT id, slug, default_md_format FROM workspaces ORDER BY slug",
    )
    .all() as Array<{
      id: number;
      slug: string;
      default_md_format: string;
    }>;

  // Resolve the caller's role and the display name via Forgejo using the
  // user's own PAT. The display name is the Forgejo repo description
  // (#61) — cosheaf no longer mirrors it. Workspaces where the user has
  // no permission are filtered out, mirroring the old membership gate.
  const fj = c.get("fjUser");
  const owner = c.get("config").forgejoOwner;
  const fjUser = c.get("user").username;
  const resolved = await Promise.all(
    rows.map(async (r) => {
      const [p, repo] = await Promise.all([
        fj.getRepoPermission(owner, r.slug, fjUser).catch(() => "none" as const),
        fj.getRepo(owner, r.slug).catch(() => null),
      ]);
      return p === "none"
        ? null
        : {
            id: r.id,
            slug: r.slug,
            name: repo?.description?.trim() || r.slug,
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

  const taken = db.prepare("SELECT 1 FROM workspaces WHERE slug = ?").get(body.slug);
  if (taken) return c.json(...conflict("slug already taken"));

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
      return c.json(...conflict("slug already taken"));
    }
    return c.json(
      { error: `workspace create failed: ${(err as Error).message}`, code: "internal" },
      500,
    );
  }
});
