import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { ForgejoError } from "../forgejo.js";
import { validBranchName } from "../branch-path.js";
import { REPO_CONFIG_PATH, bustRepoConfig, loadRepoConfig } from "../repo-config.js";
import { planIndexPage } from "../indexer.js";
import { searchWorkspacePages } from "../page-search.js";
import { getCachedTree, invalidateBranchTree, setCachedTree } from "../tree-cache.js";
import { workspaceSupportsXrefs, workspaceValidation } from "../workspace-validation.js";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
} from "../../shared/conventions.js";
import { fileKindForPath, isEditableTextFile } from "../../shared/file-kind.js";
import type { WorkspaceValidation } from "../../shared/validation.js";
import { bad, conflict, notFound } from "./responses.js";
import { streamHubChannel } from "./sse-helpers.js";
import { parseBoundedPositiveInt } from "./query-params.js";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs.js";
import { extractFirstH1, parseFrontmatterYaml } from "../../shared/frontmatter-yaml.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:owner/:repo/*", requireMembership());
files.use("/:owner/:repo/*", requireWriteOnMutation);

interface RefSuggestion {
  id: string;
  insert: string;
  display: string;
}

interface BranchRefEntry {
  id: string;
  title: string | null;
  path: string;
}

const BRANCH_REF_CACHE_MAX = 128;
const BRANCH_REF_CACHE_TTL_MS = 5 * 60_000;
const branchRefCache = new Map<string, { expiresAt: number; entries: readonly BranchRefEntry[] }>();

// Repository-relative path validator. Rejects absolute paths, traversal
// segments (`.` or `..`), empty segments, backslashes (Forgejo treats `/` as the
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
  if (p.split(/[/\\]/).some((seg) => seg === "." || seg === ".." || seg === "")) return null;
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

function validRequestedBranch(branch: string): boolean {
  return branch === "main" || validBranchName(branch);
}

function branchRefCacheKey(owner: string, repo: string, branch: string, tree: readonly { path: string; sha?: string; size?: number }[]): string {
  return `${owner}|${repo}|${branch}|${tree.map((entry) => `${entry.path}:${entry.sha ?? ""}:${entry.size ?? ""}`).join("\n")}`;
}

function getCachedBranchRefs(key: string): readonly BranchRefEntry[] | null {
  const cached = branchRefCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    branchRefCache.delete(key);
    return null;
  }
  return cached.entries;
}

function setCachedBranchRefs(key: string, entries: readonly BranchRefEntry[]): void {
  if (branchRefCache.size >= BRANCH_REF_CACHE_MAX) {
    const first = branchRefCache.keys().next().value;
    if (first) branchRefCache.delete(first);
  }
  branchRefCache.set(key, { expiresAt: Date.now() + BRANCH_REF_CACHE_TTL_MS, entries });
}

function invalidateBranchRefs(owner: string, repo: string, branch: string): void {
  const prefix = `${owner}|${repo}|${branch}|`;
  for (const key of branchRefCache.keys()) {
    if (key.startsWith(prefix)) branchRefCache.delete(key);
  }
}

function invalidateBranchReadCaches(owner: string, repo: string, branch: string): void {
  invalidateBranchTree(owner, repo, branch);
  invalidateBranchRefs(owner, repo, branch);
}

export function _clearBranchRefCacheForTests(): void {
  branchRefCache.clear();
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
  expectedSha: string | null | undefined,
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

export async function rollbackCreatedRenameDestination(
  fj: import("../forgejo.js").Forgejo,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  createdSha: string | undefined,
): Promise<void> {
  if (!createdSha) {
    throw new Error(`rename rollback unsafe for ${path}: created blob sha missing`);
  }
  await fj.deleteFile(owner, repo, {
    branch,
    path,
    sha: createdSha,
    message: `rollback incomplete rename to ${path}`,
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
  try {
    await fj.createBranch(owner, repo, { newBranchName: branch, oldBranchName: "main" });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 409 && await fj.getBranch(owner, repo, branch)) return;
    throw err;
  }
}

files.get("/:owner/:repo/tree", async (c) => {
  const ws = c.get("workspace");
  const { fj, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  if (!validRequestedBranch(ref)) return c.json(...bad("valid branch name required"));
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

  // The SQLite sidecar is branchless and mirrors main; branch trees should not
  // inherit stale main titles/ids for unmerged branch content.
  const docs = ref === "main"
    ? c
        .get("db")
        .prepare(
          "SELECT cosheaf_id AS id, forgejo_id AS path, title FROM doc_map WHERE workspace_slug = ?",
        )
        .all(ws.slug) as Array<{ id: string; path: string; title: string | null }>
    : [];
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
  if (!validRequestedBranch(ref)) return c.json(...bad("valid branch name required"));
  let branchInfo: Awaited<ReturnType<typeof fj.getBranch>> | null = null;
  try {
    branchInfo = await fj.getBranch(owner, repo, ref);
    const snapshotRef = branchInfo?.commit?.id ?? ref;
    const [content, meta] = await Promise.all([
      fj.getRawFile(owner, repo, snapshotRef, rel),
      fj.getFileMeta(owner, repo, snapshotRef, rel),
    ]);
    return c.json({ content, sha: meta?.sha ?? null });
  } catch (err) {
    if (err instanceof ForgejoError && err.status === 404 && ref !== "main") {
      // File not on the branch — fall back to main so the editor can still
      // show the canonical version.
      try {
        const mainInfo = await fj.getBranch(owner, repo, "main");
        const mainRef = mainInfo?.commit?.id ?? "main";
        const [content, meta] = await Promise.all([
          fj.getRawFile(owner, repo, mainRef, rel),
          fj.getFileMeta(owner, repo, mainRef, rel),
        ]);
        return c.json({
          content,
          sha: branchInfo ? null : (meta?.sha ?? null),
          source_ref: "main",
          source_sha: meta?.sha ?? null,
        });
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
  if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
  if (branch === "main")
    return c.json(...bad("branch required (cannot write to main)"));
  const body = (await c.req.json().catch(() => null)) as {
    content?: string;
    previous_path?: string;
    expected_sha?: string | null;
    expected_source_sha?: string;
  } | null;
  if (body?.content === undefined)
    return c.json(...bad("content required"));
  if (typeof body.content !== "string")
    return c.json(...bad("content must be a string"));
  const previousRel = safeRel(body.previous_path);
  if (body.previous_path !== undefined && (!previousRel || !isEditableTextFile(previousRel)))
    return c.json(...bad("invalid previous_path"));
  let expectedSha: string | null | undefined;
  if (body && Object.hasOwn(body, "expected_sha")) {
    if (typeof body.expected_sha !== "string" && body.expected_sha !== null)
      return c.json(...bad("expected_sha must be a string or null"));
    expectedSha = body.expected_sha;
  }
  let expectedSourceSha: string | undefined;
  if (body && Object.hasOwn(body, "expected_source_sha")) {
    if (typeof body.expected_source_sha !== "string")
      return c.json(...bad("expected_source_sha must be a string"));
    expectedSourceSha = body.expected_source_sha;
  }

  await ensureBranch(c, branch);
  const { fj, owner, repo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const db = c.get("db");
  const hub = c.get("sse");

  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await fj.getFileMeta(owner, repo, branch, rel);
  if (isRename && existing)
    return c.json(...conflict("destination already exists"));
  const previous = isRename ? await fj.getFileMeta(owner, repo, branch, previousRel as string) : null;
  const fallbackRename =
    isRename && !previous && expectedSha === null && expectedSourceSha !== undefined;
  if (isRename && !previous && !fallbackRename) {
    return c.json(...conflict("source file missing; reload and retry", {
      path: previousRel as string,
      branch,
      branch_moved: true,
    }));
  }
  // Only Markdown files are pages: parse/inject the frontmatter id and index
  // doc_map/FTS/backlinks. Plain-text companions (.bib, .csv, …) are committed
  // verbatim and never indexed (mirrors the web _edit writeFile path). The
  // workspace's declared markdown format is passed explicitly so passthrough
  // workspaces don't inherit coflat indexing behavior (#25).
  const isMarkdown = fileKindForPath(rel) === "markdown";
  let mainSourceMeta: Awaited<ReturnType<typeof fj.getFileMeta>> | undefined;
  if (isRename && previous && isMarkdown && fileKindForPath(previousRel as string) === "markdown") {
    mainSourceMeta = await fj.getFileMeta(owner, repo, "main", previousRel as string);
  }
  const replacePath = isRename && previous && mainSourceMeta === null
    ? previousRel as string
    : undefined;
  const plan = isMarkdown
    ? planIndexPage(db, {
        workspaceSlug: ws.slug,
        filePath: rel,
        bodyText: body.content,
        formatId: ws.defaultMdFormat,
        replacePath,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? body.content;
  // Compare-and-set: if the caller declared the blob sha its edit was based on and
  // the branch has since moved, reject before writing so a concurrent edit isn't
  // silently clobbered (#92). On a rename the edit was based on the SOURCE blob,
  // not the (normally empty) destination — compare against the source.
  const casMeta = isRename ? previous : existing;
  const casPath = isRename ? (previousRel as string) : rel;
  if (expectedSha !== undefined && (casMeta?.sha ?? null) !== expectedSha) {
    return c.json(...(await staleShaConflict(fj, owner, repo, branch, casPath, expectedSha)));
  }
  if (expectedSourceSha !== undefined && !casMeta?.sha) {
    const sourceMeta = mainSourceMeta ?? await fj.getFileMeta(owner, repo, "main", casPath);
    if ((sourceMeta?.sha ?? null) !== expectedSourceSha) {
      return c.json(...conflict("source file changed; reload and retry", {
        path: casPath,
        branch,
        source_ref: "main",
        expected_source_sha: expectedSourceSha,
        current_source_sha: sourceMeta?.sha ?? null,
        branch_moved: true,
      }));
    }
  }
  let r;
  try {
    r = await fj.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
    });
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
  if (isRename && previous) {
    try {
      await fj.deleteFile(owner, repo, {
        branch,
        path: previousRel as string,
        sha: previous.sha,
        message: `remove ${previousRel} after rename`,
      });
    } catch (err) {
      if (!isStaleShaConflict(err)) throw err;
      try {
        await rollbackCreatedRenameDestination(fj, owner, repo, branch, rel, r.content?.sha);
      } catch (rollbackErr) {
        invalidateBranchReadCaches(owner, repo, branch);
        throw new Error(`rename rollback failed for ${rel}: ${(rollbackErr as Error).message}`);
      }
      invalidateBranchReadCaches(owner, repo, branch);
      return c.json(...(await staleShaConflict(fj, owner, repo, branch, previousRel as string, expectedSha)));
    }
  }
  // The sidecar is branchless and mirrors Forgejo main. Branch writes still use
  // the plan for frontmatter/id rewriting and response metadata, but must not
  // publish unmerged branch content into search/backlinks/tree doc metadata.
  // Deliberately do not call plan.commit() here; webhooks/reindex reconcile main.
  // #182: a cosheaf.yaml write through the typed route busts its cached config
  // for this branch so the change is read-after-write consistent (the webhook
  // only reconciles main; external non-main pushes reconcile on reindex).
  if (rel === REPO_CONFIG_PATH || previousRel === REPO_CONFIG_PATH) bustRepoConfig(db, ws.slug, branch);
  invalidateBranchReadCaches(owner, repo, branch);
  if (isRename) hub.publish(ws.slug, { type: "change", path: previousRel as string });
  hub.publish(ws.slug, { type: "change", path: rel });
  const writtenSha = r.content?.sha ?? (await fj.getFileMeta(owner, repo, branch, rel).catch(() => null))?.sha ?? null;
  return c.json({
    ok: true,
    branch,
    meta: { id: plan?.cosheafId ?? null, title: plan?.title },
    content: plan?.rewrittenContent ?? undefined,
    commit: r.commit?.sha,
    sha: writtenSha,
  });
});

files.post("/:owner/:repo/assets", async (c) => {
  const branch = c.req.query("branch")?.trim();
  if (!branch)
    return c.json(...bad("branch required"));
  if (!validBranchName(branch))
    return c.json(...bad("valid branch name required"));
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
  // Keep a readable basename plus a short random suffix so simultaneous uploads
  // of the same filename don't collide. Git still deduplicates blobs server-side.
  const safeName = predictableUploadName(file.name);
  const rand = Math.random().toString(36).slice(2, 10);
  const repoConfig = await loadRepoConfig(c.get("db"), fj, owner, repo, branch);
  const assetPath = `${repoConfig.assetFolder}/${safeName.stem}-${rand}${safeName.ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await fj.putFileBytes(owner, repo, {
    branch,
    path: assetPath,
    content: bytes,
    message: `upload ${safeName.stem}${safeName.ext}`,
  });
  invalidateBranchReadCaches(owner, repo, branch);
  return c.json({ path: assetPath });
});

function predictableUploadName(name: string): { stem: string; ext: string } {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-96) || "asset";
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return { stem: clean.slice(0, 80) || "asset", ext: "" };
  return {
    stem: clean.slice(0, dot).slice(0, 80) || "asset",
    ext: clean.slice(dot).slice(0, 16),
  };
}

files.get("/:owner/:repo/suggest", async (c) => {
  const prefix = c.req.query("prefix")?.trim() ?? "";
  const trigger = c.req.query("trigger") ?? "[@";
  const limit = parseBoundedPositiveInt(c.req.query("limit"), 10, 20);
  const ws = c.get("workspace");
  const branch = c.req.query("branch")?.trim() || "main";
  if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
  // For `[@` trigger we suggest from doc_map (cross-ref ids + titles).
  // Other triggers return empty until we add e.g. tag completion.
  if (trigger !== "[@") return c.json({ suggestions: [] });
  const term = `${prefix.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const sqlLimit = branch !== "main" ? limit * 2 : limit;
  const pageRows = c
    .get("db")
    .prepare(
      "SELECT cosheaf_id AS id, title FROM doc_map " +
        "WHERE workspace_slug = ? AND " +
        "(cosheaf_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') " +
        "ORDER BY length(cosheaf_id), cosheaf_id LIMIT ?",
    )
    .all(ws.slug, term, term, sqlLimit) as Array<{ id: string; title: string | null }>;
  const remaining = Math.max(0, sqlLimit - pageRows.length);
  const supportsXrefs = workspaceSupportsXrefs(ws.defaultMdFormat);
  const xrefRows = remaining === 0 || !supportsXrefs
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
  const mainSuggestions: RefSuggestion[] = [
      ...pageRows.map((r): RefSuggestion => ({
        id: r.id,
        insert: `${r.id}]`,
        display: r.title ? `${r.id} — ${r.title}` : r.id,
      })),
      ...xrefRows.map((r): RefSuggestion => ({
        id: r.id,
        insert: `${r.id}]`,
        display: `${r.id} — ${r.title} (${r.path})`,
      })),
    ];
  const branchSuggestions = branch !== "main" && supportsXrefs
    ? await branchRefSuggestions(c, branch, prefix, limit)
    : [];
  return c.json({ suggestions: mergeSuggestions(branchSuggestions, mainSuggestions, limit) });
});

function mergeSuggestions(primary: readonly RefSuggestion[], secondary: readonly RefSuggestion[], limit: number): RefSuggestion[] {
  const seen = new Set<string>();
  const mergedPrimary: RefSuggestion[] = [];
  const mergedSecondary: RefSuggestion[] = [];
  for (const suggestion of primary) {
    if (seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    mergedPrimary.push(suggestion);
  }
  for (const suggestion of secondary) {
    if (seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    mergedSecondary.push(suggestion);
  }
  const sortSuggestions = (items: RefSuggestion[]) =>
    items.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  return [...sortSuggestions(mergedPrimary), ...sortSuggestions(mergedSecondary)].slice(0, limit);
}

async function branchRefSuggestions(
  c: import("hono").Context<AppEnv>,
  branch: string,
  prefix: string,
  limit: number,
): Promise<RefSuggestion[]> {
  const { fj, owner, repo } = c.get("repoCtx");
  let tree = getCachedTree(owner, repo, branch);
  if (!tree) {
    try {
      tree = await fj.getTree(owner, repo, branch, true);
      setCachedTree(owner, repo, branch, tree);
    } catch (err) {
      if (err instanceof ForgejoError && (err.status === 404 || err.status === 400)) return [];
      throw err;
    }
  }
  const markdownFiles = tree
    .filter((entry) => entry.type === "blob" && fileKindForPath(entry.path) === "markdown" && (entry.size ?? 0) <= 512_000)
    .slice(0, 80);
  const cacheKey = branchRefCacheKey(owner, repo, branch, markdownFiles);
  let branchRefs = getCachedBranchRefs(cacheKey);
  if (!branchRefs) {
    branchRefs = await parseBranchRefs(c, branch, markdownFiles);
    setCachedBranchRefs(cacheKey, branchRefs);
  }
  const suggestions: RefSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of branchRefs) {
    addBranchSuggestion(suggestions, seen, entry.id, entry.title, entry.path, prefix, limit);
    if (suggestions.length >= limit) break;
  }
  return suggestions.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)).slice(0, limit);
}

async function parseBranchRefs(
  c: import("hono").Context<AppEnv>,
  branch: string,
  markdownFiles: readonly { path: string }[],
): Promise<readonly BranchRefEntry[]> {
  const { fj, owner, repo } = c.get("repoCtx");
  const entries: BranchRefEntry[] = [];
  for (const entry of markdownFiles) {
    const rel = safeRel(entry.path);
    if (!rel) continue;
    const source = await fj.getRawFile(owner, repo, branch, rel).catch(() => null);
    if (source === null) continue;
    const parsed = parseFrontmatterYaml(source);
    if (typeof parsed.frontmatter.id === "string") {
      entries.push({
        id: parsed.frontmatter.id,
        title: typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : extractFirstH1(parsed.body),
        path: rel,
      });
    }
    for (const target of extractCoflatXrefTargets(source)) entries.push({ id: target.id, title: target.label, path: rel });
  }
  return entries.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
}

function addBranchSuggestion(
  suggestions: RefSuggestion[],
  seen: Set<string>,
  id: string,
  title: string | null,
  path: string,
  prefix: string,
  limit: number,
): void {
  if (suggestions.length >= limit || seen.has(id) || !suggestionMatches(id, title, prefix)) return;
  seen.add(id);
  suggestions.push({
    id,
    insert: `${id}]`,
    display: title ? `${id} — ${title} (${path})` : `${id} (${path})`,
  });
}

function suggestionMatches(id: string, title: string | null, prefix: string): boolean {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return true;
  return id.toLowerCase().startsWith(needle) || Boolean(title?.toLowerCase().includes(needle));
}

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
  const supportsXrefs = workspaceSupportsXrefs(ws.defaultMdFormat);
  const xrefRows = supportsXrefs
    ? c
        .get("db")
        .prepare(
          `SELECT target_id AS id, source_path AS path, kind, display_label AS label, line
             FROM xref_targets
            WHERE workspace_slug = ? AND target_id IN (${placeholders})
            ORDER BY source_path`,
        )
        .all(ws.slug, ...ids) as Array<{ id: string; path: string; kind: string; label: string; line: number | null }>
    : [];
  const sameFileDuplicates = supportsXrefs
    ? c
        .get("db")
        .prepare(
          `SELECT target_id AS id, source_path AS path, count
             FROM xref_target_duplicates
            WHERE workspace_slug = ? AND target_id IN (${placeholders})
            ORDER BY source_path`,
        )
        .all(ws.slug, ...ids) as Array<{ id: string; path: string; count: number }>
    : [];
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
  if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
  if (branch === "main")
    return c.json(...bad("branch required (cannot delete on main)"));
  const rawBody = await c.req.text().catch(() => null);
  if (rawBody === null)
    return c.json(...bad("invalid JSON body"));
  let body: unknown = null;
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch (_err) {
      return c.json(...bad("invalid JSON body"));
    }
  }
  let expectedSha: string | null | undefined = c.req.query("expected_sha");
  if (body !== null) {
    if (typeof body !== "object" || Array.isArray(body))
      return c.json(...bad("invalid JSON body"));
    if (Object.hasOwn(body, "expected_sha")) {
      const value = (body as { expected_sha?: unknown }).expected_sha;
      if (typeof value !== "string" && value !== null)
        return c.json(...bad("expected_sha must be a string or null"));
      expectedSha = value;
    }
  }
  const { fj, owner, repo } = c.get("repoCtx");
  const meta = await fj.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json(...notFound());
  if (expectedSha !== undefined && meta.sha !== expectedSha) {
    return c.json(...(await staleShaConflict(fj, owner, repo, branch, rel, expectedSha)));
  }
  try {
    await fj.deleteFile(owner, repo, {
      branch,
      path: rel,
      sha: meta.sha,
      message: `delete ${rel}`,
    });
  } catch (err) {
    if (isStaleShaConflict(err)) {
      return c.json(...(await staleShaConflict(fj, owner, repo, branch, rel, expectedSha)));
    }
    throw err;
  }
  const db = c.get("db");
  const ws = c.get("workspace");
  if (rel === REPO_CONFIG_PATH) bustRepoConfig(db, ws.slug, branch);
  invalidateBranchReadCaches(owner, repo, branch);
  c.get("sse").publish(ws.slug, { type: "change", path: rel });
  return c.json({ ok: true, branch });
});

files.get("/:owner/:repo/search", (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ results: [] });
  const limit = parseBoundedPositiveInt(c.req.query("limit"), 25, 50);
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
  return c.json(workspaceValidation(c.get("db"), ws.slug, ws.defaultMdFormat) satisfies WorkspaceValidation);
});

files.get("/:owner/:repo/events", (c) => streamHubChannel(c, c.get("sse"), c.get("workspace").slug));
