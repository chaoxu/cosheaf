import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { deletePage, planIndexPage } from "../indexer.js";
import { searchWorkspacePages } from "../page-search.js";
import { getCachedTree, invalidateBranchTree, setCachedTree } from "../tree-cache.js";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
} from "../../shared/conventions.js";
import { fileKindForPath, isEditableTextFile } from "../../shared/file-kind.js";
import type { WorkspaceValidation } from "../../shared/validation.js";
import { bad, conflict, notFound } from "./responses.js";
import { streamHubChannel } from "./sse-helpers.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:owner/:repo/*", requireMembership());
files.use("/:owner/:repo/*", requireWriteOnMutation);

// Repository-relative path validator. Rejects absolute paths, traversal
// segments (`..`), empty segments, backslashes (Forgejo treats `/` as the
// only separator), control characters, and encoded-traversal forms. Exported
// so other typed routes (e.g. PR review-comment paths) can apply the same
// shape check.
export function safeRel(p: string | undefined): string | null {
  if (!p) return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || p[i] === "\\") return null;
  }
  if (p.split(/[/\\]/).some((seg) => seg === ".." || seg === "")) return null;
  if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) return null;
  return p;
}

// Resolve which Forgejo ref to read/write from. Caller passes ?branch=<name>;
// missing/blank means `main`. We don't validate "is this user's branch" — that
// is Forgejo's job (push rejections via branch protection).
function refFromQuery(c: import("hono").Context<AppEnv>): string {
  const b = c.req.query("branch")?.trim();
  return b && b.length > 0 ? b : "main";
}

// A write that lost a branch-head race: Forgejo rejects a stale blob sha as
// 422 "sha does not match", or a push-level reject as 409. Shared by the typed
// file route and the web _edit path so both classify concurrent writes the
// same way.
export function isStaleShaConflict(err: unknown): boolean {
  return (
    err instanceof ForgejoError &&
    (err.status === 409 || (err.status === 422 && /sha does not match/i.test(err.bodyText)))
  );
}

// Build the typed 409 for a concurrent-write conflict: re-read the live branch
// head + current blob sha so the agent can rebase its edit and retry (#92).
// Best-effort — if the branch was deleted concurrently the lookups 404, and we
// still return a useful conflict rather than throwing a fresh error.
export async function staleShaConflict(
  fj: import("../forgejo.js").Forgejo,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  expectedSha: string | undefined,
): Promise<readonly [import("./responses.js").ErrorBody, 409]> {
  const [meta, branchInfo] = await Promise.all([
    fj.getFileMeta(owner, repo, branch, path).catch(() => null),
    fj.getBranch(owner, repo, branch).catch(() => null),
  ]);
  return conflict("branch head moved; reload and retry", {
    path,
    branch,
    head_sha: branchInfo?.commit?.id ?? null,
    current_sha: meta?.sha ?? null,
    ...(expectedSha !== undefined ? { expected_sha: expectedSha } : {}),
    branch_moved: true,
  });
}

// Auto-create the target branch from `main` if it doesn't exist. Any valid
// branch name is allowed — cosheaf's job is to be a thin shell over Forgejo's
// branch model, not to enforce a naming convention Forgejo itself doesn't
// require. Write-member gating happens upstream via requireWriteOnMutation.
async function ensureBranch(
  c: import("hono").Context<AppEnv>,
  branch: string,
): Promise<void> {
  if (branch === "main") return;
  const { fj, owner, repo } = c.get("repoCtx");
  const exists = await fj.getBranch(owner, repo, branch);
  if (exists) return;
  await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
}

files.get("/:owner/:repo/tree", async (c) => {
  const ws = c.get("workspace");
  const { fj, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  let tree = getCachedTree(owner, repo, ref);
  if (!tree) {
    try {
      tree = await fj.getTree(owner, repo, ref, true);
      setCachedTree(owner, repo, ref, tree);
    } catch (err) {
      // Forgejo returns 404 for a missing ref *or* 400 with "sha not found"
      // for a branch that was deleted while a client still held its name
      // (e.g. squash-merge dropped the head branch). Either way, fall back
      // to main so a stale tab keeps rendering.
      const missing =
        err instanceof ForgejoError &&
        (err.status === 404 || (err.status === 400 && /sha not found/i.test(err.bodyText)));
      if (missing && ref !== "main") {
        tree = getCachedTree(owner, repo, "main") ?? (await fj.getTree(owner, repo, "main", true));
        setCachedTree(owner, repo, "main", tree);
      } else {
        throw err;
      }
    }
  }
  const out = tree
    .filter((e) => e.type === "blob")
    .map((e) => ({ path: e.path, size: e.size ?? 0, kind: fileKindForPath(e.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const docs = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, forgejo_id AS path, title FROM doc_map WHERE workspace_slug = ?",
    )
    .all(ws.slug) as Array<{ id: string; path: string; title: string | null }>;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const merged = out.map((f) => {
    const meta = byPath.get(f.path);
    return meta
      ? { ...f, doc: { id: meta.id, title: meta.title } }
      : f;
  });
  return c.json({ files: merged });
});

files.get("/:owner/:repo/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel) return c.json(...bad("path required"));
  const { fj, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  try {
    const content = await fj.getRawFile(owner, repo, ref, rel);
    return c.json({ content });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      // File not on the branch — fall back to main so the editor can still
      // show the canonical version.
      try {
        const content = await fj.getRawFile(owner, repo, "main", rel);
        return c.json({ content });
      } catch (err2) {
        if (err2 instanceof ForgejoError && err2.status === 404)
          return c.json(...notFound());
        throw err2;
      }
    }
    if (err instanceof ForgejoError && err.status === 404)
      return c.json(...notFound());
    throw err;
  }
});

files.put("/:owner/:repo/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !isEditableTextFile(rel))
    return c.json(...bad("invalid path"));
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json(...bad("branch required (cannot write to main)"));
  const body = (await c.req.json().catch(() => null)) as {
    content?: string;
    previous_path?: string;
    expected_sha?: string;
  } | null;
  if (body?.content === undefined)
    return c.json(...bad("content required"));
  const previousRel = safeRel(body.previous_path);
  if (body.previous_path !== undefined && !previousRel)
    return c.json(...bad("invalid previous_path"));
  const expectedSha = typeof body.expected_sha === "string" ? body.expected_sha : undefined;

  await ensureBranch(c, branch);
  const { fj, owner, repo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const db = c.get("db");
  const hub = c.get("sse");

  // Only Markdown files are pages: parse/inject the frontmatter id and index
  // doc_map/FTS/backlinks. Plain-text companions (.bib, .csv, …) are committed
  // verbatim and never indexed (mirrors the web _edit writeFile path). The
  // workspace's declared markdown format is passed explicitly so passthrough
  // workspaces don't inherit coflat indexing behavior (#25).
  const isMarkdown = fileKindForPath(rel) === "markdown";
  const plan = isMarkdown
    ? planIndexPage(db, {
        workspaceSlug: ws.slug,
        filePath: rel,
        bodyText: body.content,
        formatId: ws.defaultMdFormat,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? body.content;

  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await fj.getFileMeta(owner, repo, branch, rel);
  if (isRename && existing)
    return c.json(...conflict("destination already exists"));
  // Compare-and-set: if the caller declared the blob sha its edit was based on
  // and the branch has since moved, reject before issuing the write so a
  // concurrent edit isn't silently clobbered (#92).
  if (expectedSha !== undefined && (existing?.sha ?? null) !== expectedSha) {
    return c.json(...(await staleShaConflict(fj, owner, repo, branch, rel, expectedSha)));
  }
  const previous = isRename ? await fj.getFileMeta(owner, repo, branch, previousRel as string) : null;
  let r;
  try {
    r = await fj.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
    });
    if (isRename && previous) {
      await fj.deleteFile(owner, repo, {
        branch,
        path: previousRel as string,
        sha: previous.sha,
        message: `remove ${previousRel} after rename`,
      });
    }
  } catch (err) {
    // A concurrent writer landed a commit between our getFileMeta read and the
    // putFile: Forgejo rejects the stale blob sha as 422 "sha does not match"
    // (a push-level reject is 409). Either way, surface a typed, recoverable
    // conflict instead of a bare 502 (#92).
    if (isStaleShaConflict(err)) {
      return c.json(...(await staleShaConflict(fj, owner, repo, branch, rel, expectedSha)));
    }
    throw err;
  }
  // Commit the sidecar reindex now that the canonical write succeeded.
  // Without this, doc_map / FTS / backlinks would lag until the webhook
  // fires and typed read-after-write (search, suggest, /backlinks) breaks.
  // The sidecar tracks the latest write across branches (no branch dimension);
  // title display is therefore scoped to the main file view (#132).
  plan?.commit();
  if (isRename) deletePage(db, ws.slug, previousRel as string);
  invalidateBranchTree(owner, repo, branch);
  if (isRename) hub.publish(ws.slug, { type: "change", path: previousRel as string });
  hub.publish(ws.slug, { type: "change", path: rel });
  return c.json({
    ok: true,
    branch,
    meta: { id: plan?.cosheafId ?? null, title: plan?.title },
    content: plan?.rewrittenContent ?? undefined,
    commit: r.commit?.sha,
    sha: r.content?.sha,
  });
});

files.post("/:owner/:repo/assets", async (c) => {
  const branch = c.req.query("branch")?.trim();
  if (!branch)
    return c.json(...bad("branch required"));
  if (branch === "main")
    return c.json(...bad("branch required (cannot upload assets to main)"));
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return c.json(...bad("file field required"));
  if (file.size > MAX_ASSET_BYTES)
    return c.json(...bad(`asset exceeds ${MAX_ASSET_DISPLAY}`));
  const { fj, owner, repo } = c.get("repoCtx");
  await ensureBranch(c, branch);
  // Random-prefixed under assets/ so two simultaneous uploads of the same
  // filename don't collide. We don't try to dedupe by content hash here;
  // git already deduplicates blobs server-side.
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "asset";
  const rand = Math.random().toString(36).slice(2, 10);
  const assetPath = `assets/${rand}-${safeName}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await fj.putFileBytes(owner, repo, {
    branch,
    path: assetPath,
    content: bytes,
    message: `upload ${safeName}`,
  });
  invalidateBranchTree(owner, repo, branch);
  return c.json({ path: assetPath });
});

files.get("/:owner/:repo/suggest", (c) => {
  const prefix = c.req.query("prefix")?.trim() ?? "";
  const trigger = c.req.query("trigger") ?? "[@";
  const rawLimit = Number(c.req.query("limit") ?? 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 10;
  const ws = c.get("workspace");
  // For `[@` trigger we suggest from doc_map (cross-ref ids + titles).
  // Other triggers return empty until we add e.g. tag completion.
  if (trigger !== "[@") return c.json({ suggestions: [] });
  const term = `${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const pageRows = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, title FROM doc_map " +
        "WHERE workspace_slug = ? AND " +
        "(cosheaf_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') " +
        "ORDER BY length(cosheaf_id), cosheaf_id LIMIT ?",
    )
    .all(ws.slug, term, term, limit) as Array<{ id: string; title: string | null }>;
  const remaining = Math.max(0, limit - pageRows.length);
  const xrefRows = remaining === 0
    ? []
    : c
        .get("db")
        .prepare(
          "SELECT target_id AS id, display_label AS title, source_path AS path FROM xref_targets " +
            "WHERE workspace_slug = ? AND " +
            "(target_id LIKE ? ESCAPE '\\' OR display_label LIKE ? ESCAPE '\\') " +
            "ORDER BY length(target_id), target_id LIMIT ?",
        )
        .all(ws.slug, term, term, remaining) as Array<{ id: string; title: string; path: string }>;
  return c.json({
    suggestions: [
      ...pageRows.map((r) => ({
        id: r.id,
        insert: `${r.id}]`,
        display: r.title ? `${r.id} — ${r.title}` : r.id,
      })),
      ...xrefRows.map((r) => ({
        id: r.id,
        insert: `${r.id}]`,
        display: `${r.id} — ${r.title} (${r.path})`,
      })),
    ],
  });
});

files.get("/:owner/:repo/refs", (c) => {
  const ids = [
    ...new Set(
      (c.req.query("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^[\w.:-]+$/.test(id))
        .slice(0, 50),
    ),
  ];
  if (ids.length === 0) return c.json({ refs: [] });
  const ws = c.get("workspace");
  const placeholders = ids.map(() => "?").join(",");
  const pageRows = c
    .get("db")
    .prepare(
      `SELECT cosheaf_id AS id, forgejo_id AS path, COALESCE(title, cosheaf_id) AS label
         FROM doc_map
        WHERE workspace_slug = ? AND cosheaf_id IN (${placeholders})`,
    )
    .all(ws.slug, ...ids) as Array<{ id: string; path: string; label: string }>;
  const xrefRows = c
    .get("db")
    .prepare(
      `SELECT target_id AS id, source_path AS path, kind, display_label AS label, line
         FROM xref_targets
        WHERE workspace_slug = ? AND target_id IN (${placeholders})
        ORDER BY source_path`,
    )
    .all(ws.slug, ...ids) as Array<{ id: string; path: string; kind: string; label: string; line: number | null }>;
  const sameFileDuplicates = c
    .get("db")
    .prepare(
      `SELECT target_id AS id, source_path AS path, count
         FROM xref_target_duplicates
        WHERE workspace_slug = ? AND target_id IN (${placeholders})
        ORDER BY source_path`,
    )
    .all(ws.slug, ...ids) as Array<{ id: string; path: string; count: number }>;
  const xrefGroups = new Map<string, typeof xrefRows>();
  for (const row of xrefRows) xrefGroups.set(row.id, [...(xrefGroups.get(row.id) ?? []), row]);
  const duplicateIds = new Set(sameFileDuplicates.map((row) => row.id));
  const unambiguousXrefs = [...xrefGroups.entries()]
    .filter(([id, rows]) => rows.length === 1 && !duplicateIds.has(id))
    .flatMap(([, rows]) => rows);
  const ambiguousRefs = [...xrefGroups.entries()]
    .filter(([id, rows]) => rows.length > 1 || duplicateIds.has(id))
    .map(([id, rows]) => ({
      id,
      paths: [
        ...new Set([
          ...rows
            .filter((row) => !sameFileDuplicates.some((duplicate) => duplicate.id === id && duplicate.path === row.path))
            .map((row) => row.path),
          ...sameFileDuplicates.filter((row) => row.id === id).map((row) => `${row.path} (${row.count} definitions)`),
        ]),
      ],
    }));
  return c.json({
    refs: [
      ...pageRows.map((r) => ({
        id: r.id,
        path: r.path,
        kind: "page",
        label: r.label,
      })),
      ...unambiguousXrefs.map((r) => ({
        id: r.id,
        path: r.path,
        kind: r.kind,
        label: r.label,
        fragment: r.id,
        line: r.line,
      })),
    ],
    ambiguous_refs: ambiguousRefs,
  });
});

files.delete("/:owner/:repo/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !isEditableTextFile(rel))
    return c.json(...bad("invalid path"));
  const branch = refFromQuery(c);
  if (branch === "main")
    return c.json(...bad("branch required (cannot delete on main)"));
  await ensureBranch(c, branch);
  const { fj, owner, repo } = c.get("repoCtx");
  const meta = await fj.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json(...notFound());
  await fj.deleteFile(owner, repo, {
    branch,
    path: rel,
    sha: meta.sha,
    message: `delete ${rel}`,
  });
  invalidateBranchTree(owner, repo, branch);
  return c.json({ ok: true, branch });
});

files.get("/:owner/:repo/search", (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ results: [] });
  const rawLimit = Number(c.req.query("limit") ?? 25);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 25;
  try {
    return c.json({ results: searchWorkspacePages(c.get("db"), c.get("workspace").slug, q, limit) });
  } catch (err) {
    return c.json(...bad(`search failed: ${(err as Error).message}`));
  }
});

files.get("/:owner/:repo/backlinks", (c) => {
  const id = c.req.query("id");
  if (!id) return c.json(...bad("id required"));
  const ws = c.get("workspace");
  const rows = c
    .get("db")
    .prepare(
      `SELECT backlinks.src_id AS src_id, backlinks.src_path AS src_path,
              doc_map.title AS src_title, backlinks.target_label AS target_label
         FROM backlinks
         LEFT JOIN doc_map
           ON doc_map.workspace_slug = backlinks.workspace_slug
          AND doc_map.cosheaf_id = backlinks.src_id
        WHERE backlinks.workspace_slug = ? AND backlinks.target_id = ?
        ORDER BY backlinks.src_path`,
    )
    .all(ws.slug, id);
  return c.json({ backlinks: rows });
});

files.get("/:owner/:repo/validation", (c) => {
  const ws = c.get("workspace");
  const db = c.get("db");
  const brokenRefs = db
    .prepare(
      `SELECT b.src_id AS source_id,
              b.src_path AS source_path,
              src.title AS source_title,
              b.target_id AS target_id,
              b.target_label AS target_label,
              b.line AS line
         FROM backlinks b
         LEFT JOIN doc_map src
           ON src.workspace_slug = b.workspace_slug
          AND src.cosheaf_id = b.src_id
        WHERE b.workspace_slug = ?
          AND (
            b.target_id IS NULL
            OR (
              NOT EXISTS (
                SELECT 1 FROM doc_map target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.cosheaf_id = b.target_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM xref_targets target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.target_id = b.target_id
              )
            )
          )
        ORDER BY b.src_path, b.line, b.target_label`,
    )
    .all(ws.slug) as WorkspaceValidation["broken_refs"];
  const orphanLabels = db
    .prepare(
      `SELECT d.cosheaf_id AS id,
              d.forgejo_id AS path,
              d.title AS title
         FROM doc_map d
         LEFT JOIN backlinks b
           ON b.workspace_slug = d.workspace_slug
          AND b.target_id = d.cosheaf_id
          AND b.src_id != d.cosheaf_id
        WHERE d.workspace_slug = ?
          AND b.src_id IS NULL
        ORDER BY d.forgejo_id`,
    )
    .all(ws.slug) as WorkspaceValidation["orphan_labels"];
  const duplicateXrefs = db
    .prepare(
      `SELECT id, group_concat(path_note, ', ') AS paths, sum(count) AS count
         FROM (
           SELECT target_id AS id, source_path AS path_note, 1 AS count
             FROM xref_targets
            WHERE workspace_slug = ?
              AND NOT EXISTS (
                SELECT 1 FROM xref_target_duplicates duplicate
                 WHERE duplicate.workspace_slug = xref_targets.workspace_slug
                   AND duplicate.target_id = xref_targets.target_id
                   AND duplicate.source_path = xref_targets.source_path
              )
           UNION ALL
           SELECT target_id AS id, source_path || ' (' || count || ' definitions)' AS path_note, count
             FROM xref_target_duplicates
            WHERE workspace_slug = ?
         )
        GROUP BY id
       HAVING sum(count) > 1
        ORDER BY id`,
    )
    .all(ws.slug, ws.slug) as WorkspaceValidation["duplicate_xrefs"];
  return c.json({ broken_refs: brokenRefs, duplicate_xrefs: duplicateXrefs, orphan_labels: orphanLabels } satisfies WorkspaceValidation);
});

files.get("/:owner/:repo/events", (c) => streamHubChannel(c, c.get("sse"), c.get("workspace").slug));
