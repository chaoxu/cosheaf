import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { isLocalMode, requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import {
  WorkspaceBackendError,
  isStaleShaConflict,
  type WorkspaceBackend,
} from "../workspace-backend.js";
import { validBranchName } from "../branch-path.js";
import { isRetiredDefaultEditBranch } from "../edit-branch-retirement.js";
import { gitBlobHash } from "../git-object.js";
import { REPO_CONFIG_PATH, bustRepoConfig, loadRepoConfig } from "../repo-config.js";
import { indexLocalDelete, indexLocalWrite, planIndexPage } from "../indexer.js";
import { getCachedTree, invalidateBranchTree, setCachedTree } from "../tree-cache.js";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DISPLAY,
  userBranchPrefix,
} from "../../shared/conventions.js";
import { fileKindForPath, isEditableTextFile } from "../../shared/file-kind.js";
import { bad, conflict, notFound } from "./responses.js";
import { invalidateBranchRefs, registerFileRefRoutes } from "./files-refs.js";
import { streamHubChannel } from "./sse-helpers.js";
import { assertLocalAnnotationsReadable, localAnnotationSidecarConflict, moveLocalAnnotationsPath } from "../local/local-annotations.js";
import { publishLocalAnnotationEvent, publishLocalFileMutationEvents } from "../local/local-events.js";
import { resolveLocalWorkspace } from "../local/local-mode.js";

export const files = new Hono<AppEnv>();
files.use("*", requireAuth);
files.use("/:owner/:repo/*", requireMembership());
files.use("/:owner/:repo/*", requireWriteOnMutation);

interface ContentsWriteBody {
  content?: string;
  branch?: string;
  new_branch?: string;
  message?: string;
  sha?: string;
}

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

export function validRequestedBranch(branch: string): boolean {
  return branch === "main" || validBranchName(branch);
}

function invalidateBranchReadCaches(owner: string, repo: string, branch: string): void {
  invalidateBranchTree(owner, repo, branch);
  invalidateBranchRefs(owner, repo, branch);
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function giteaContentShape(c: import("hono").Context<AppEnv>, path: string, meta: {
  sha: string | null;
  size: number;
  content: Buffer;
}): Record<string, unknown> {
  // Encode each path segment: safeRel permits `#` and `?` in filenames, which the
  // URL parser would otherwise split off as fragment/query and truncate the path.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const apiPath = `/api/v1/repos/${encodeURIComponent(c.req.param("owner") ?? "")}/${encodeURIComponent(c.req.param("repo") ?? "")}/contents/${encodedPath}`;
  const url = new URL(apiPath, c.req.url).toString();
  return {
    name: basename(path),
    path,
    sha: meta.sha,
    size: meta.size,
    type: "file",
    content: meta.content.toString("base64"),
    encoding: "base64",
    url,
    html_url: null,
    git_url: null,
    download_url: null,
    _links: {
      self: url,
      git: null,
      html: null,
    },
  };
}

function decodeBase64Content(value: string | undefined): Buffer | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return null;
  return Buffer.from(compact, "base64");
}

async function ensureBranchFrom(
  c: import("hono").Context<AppEnv>,
  branch: string,
  baseBranch: string,
): Promise<void> {
  if (branch === baseBranch) return;
  const { backend, owner, repo } = c.get("repoCtx");
  const exists = await backend.getBranch(owner, repo, branch);
  if (exists) return;
  try {
    await backend.createBranch(owner, repo, { newBranchName: branch, oldBranchName: baseBranch });
  } catch (err) {
    if (err instanceof WorkspaceBackendError && err.status === 409 && await backend.getBranch(owner, repo, branch)) return;
    throw err;
  }
}

// A write that lost a branch-head race. Classification now lives on the backend
// seam (WorkspaceBackendError code "stale_sha"); re-exported here so the web
// editor save path keeps importing it from this module.
export { isStaleShaConflict };

// Build the typed 409 for a concurrent-write conflict: re-read the live branch
// head + current blob sha so the agent can rebase its edit and retry (#92).
// Best-effort — if the branch was deleted concurrently the lookups 404, and we
// still return a useful conflict rather than throwing a fresh error.
export async function staleShaConflict(
  backend: WorkspaceBackend,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  expectedSha: string | null | undefined,
): Promise<readonly [import("./responses.js").ErrorBody, 409]> {
  const [meta, branchInfo] = await Promise.all([
    backend.getFileMeta(owner, repo, branch, path).catch(() => null),
    backend.getBranch(owner, repo, branch).catch(() => null),
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
  backend: WorkspaceBackend,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  createdSha: string | undefined,
): Promise<void> {
  if (!createdSha) {
    throw new Error(`rename rollback unsafe for ${path}: created blob sha missing`);
  }
  await backend.deleteFile(owner, repo, {
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
  await ensureBranchFrom(c, branch, "main");
}

async function retiredDefaultEditBranch(c: import("hono").Context<AppEnv>, branch: string): Promise<boolean> {
  const { backend, owner, repo } = c.get("repoCtx");
  return isRetiredDefaultEditBranch({
    backend,
    owner,
    repo,
    branch,
    defaultEditBranch: `${userBranchPrefix(c.get("user").username)}web-edit`,
  });
}

async function resetRetiredEditBranch(c: import("hono").Context<AppEnv>, branch: string): Promise<boolean> {
  if (!await retiredDefaultEditBranch(c, branch)) return false;
  const { backend, owner, repo } = c.get("repoCtx");
  try {
    await backend.deleteBranch(owner, repo, branch);
  } catch (err) {
    if (!(err instanceof WorkspaceBackendError && err.status === 404)) throw err;
  }
  invalidateBranchReadCaches(owner, repo, branch);
  return true;
}

files.get("/:owner/:repo/tree", async (c) => {
  const ws = c.get("workspace");
  const { backend, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  if (!validRequestedBranch(ref)) return c.json(...bad("valid branch name required"));
  let tree = getCachedTree(owner, repo, ref);
  if (!tree) {
    try {
      tree = await backend.getTree(owner, repo, ref, true);
      setCachedTree(owner, repo, ref, tree);
    } catch (err) {
      // Forgejo returns 404 for a missing ref *or* 400 with "sha not found"
      // for a branch that was deleted while a client still held its name
      // (e.g. squash-merge dropped the head branch). Either way, fall back
      // to main so a stale tab keeps rendering.
      const missing =
        err instanceof WorkspaceBackendError &&
        (err.code === "not_found" || err.code === "ref_missing");
      if (missing && ref !== "main") {
        tree = getCachedTree(owner, repo, "main") ?? (await backend.getTree(owner, repo, "main", true));
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

files.get("/:owner/:repo/contents/:path{.+}", async (c) => {
  const rel = safeRel(c.req.param("path"));
  if (!rel) return c.json(...bad("invalid path"));
  const ref = c.req.query("ref")?.trim() || c.req.query("branch")?.trim() || "main";
  if (!validRequestedBranch(ref)) return c.json(...bad("valid branch name required"));
  const { backend, owner, repo } = c.get("repoCtx");
  try {
    const [content, meta] = await Promise.all([
      backend.getRawFileBytes(owner, repo, ref, rel),
      backend.getFileMeta(owner, repo, ref, rel),
    ]);
    if (!meta) return c.json(...notFound());
    return c.json(giteaContentShape(c, rel, {
      sha: meta.sha,
      size: meta.size ?? content.length,
      content,
    }));
  } catch (err) {
    if (err instanceof WorkspaceBackendError && err.status === 404) return c.json(...notFound());
    throw err;
  }
});

async function writeContentsCompat(c: import("hono").Context<AppEnv>, createdStatus: 200 | 201): Promise<Response> {
  const rel = safeRel(c.req.param("path"));
  if (!rel || !isEditableTextFile(rel)) return c.json(...bad("invalid path"));
  const body = (await c.req.json().catch(() => null)) as ContentsWriteBody | null;
  const decoded = decodeBase64Content(body?.content);
  if (!decoded) return c.json(...bad("base64 content required"));
  const baseBranch = body?.branch?.trim() || "main";
  const branch = body?.new_branch?.trim() || baseBranch;
  if (!validRequestedBranch(baseBranch) || !validRequestedBranch(branch))
    return c.json(...bad("valid branch name required"));
  if (branch === "main" && !isLocalMode(c))
    return c.json(...bad("branch required (cannot write to main)"));

  await ensureBranchFrom(c, branch, baseBranch);
  const content = decoded.toString("utf8");
  const { backend, owner, repo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const existing = await backend.getFileMeta(owner, repo, branch, rel);
  if (existing && (typeof body?.sha !== "string" || body.sha.trim() === "")) {
    // Updating an existing file requires its sha (compare-and-set), matching
    // Gitea's contents API and this route's own DELETE. A blind write without a
    // sha would silently clobber a concurrent commit (lost update). Creating a
    // new file needs no sha. The conflict body carries current_sha to retry with.
    return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, undefined)));
  }
  if (typeof body?.sha === "string" && (existing?.sha ?? null) !== body.sha) {
    return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, body.sha)));
  }
  const isMarkdown = fileKindForPath(rel) === "markdown";
  const plan = isMarkdown
    ? planIndexPage(c.get("db"), {
        workspaceSlug: ws.slug,
        filePath: rel,
        bodyText: content,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? content;
  let written;
  try {
    written = await backend.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: body?.message?.trim() || (existing ? `update ${rel}` : `create ${rel}`),
    });
  } catch (err) {
    if (isStaleShaConflict(err)) {
      return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, body?.sha)));
    }
    throw err;
  }
  indexLocalWrite(isLocalMode(c), c.get("db"), ws.slug, plan);
  invalidateBranchReadCaches(owner, repo, branch);
  if (isLocalMode(c)) publishLocalFileMutationEvents(c, ws.slug, { action: "changed", path: rel });
  else c.get("sse").publish(ws.slug, { type: "change", path: rel });
  const writtenSha = written.content?.sha ?? (await backend.getFileMeta(owner, repo, branch, rel).catch(() => null))?.sha ?? null;
  return c.json({
    content: giteaContentShape(c, rel, {
      sha: writtenSha,
      size: Buffer.byteLength(finalContent, "utf8"),
      content: Buffer.from(finalContent, "utf8"),
    }),
    commit: written.commit,
  }, existing ? 200 : createdStatus);
}

files.post("/:owner/:repo/contents/:path{.+}", (c) => writeContentsCompat(c, 201));
files.put("/:owner/:repo/contents/:path{.+}", (c) => writeContentsCompat(c, 200));

files.delete("/:owner/:repo/contents/:path{.+}", async (c) => {
  const rel = safeRel(c.req.param("path"));
  if (!rel) return c.json(...bad("invalid path"));
  const body = (await c.req.json().catch(() => null)) as {
    branch?: string;
    message?: string;
    sha?: string;
  } | null;
  const branch = body?.branch?.trim() || "main";
  if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
  if (branch === "main" && !isLocalMode(c)) return c.json(...bad("branch required (cannot delete on main)"));
  if (typeof body?.sha !== "string" || body.sha.trim() === "") return c.json(...bad("sha required"));
  const { backend, owner, repo } = c.get("repoCtx");
  await ensureBranch(c, branch);
  const meta = await backend.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json(...notFound());
  if (meta.sha !== body.sha) return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, body.sha)));
  await backend.deleteFile(owner, repo, {
    branch,
    path: rel,
    sha: body.sha,
    message: body.message?.trim() || `delete ${rel}`,
  });
  indexLocalDelete(isLocalMode(c), c.get("db"), c.get("workspace").slug, rel);
  invalidateBranchReadCaches(owner, repo, branch);
  if (isLocalMode(c)) publishLocalFileMutationEvents(c, c.get("workspace").slug, { action: "removed", path: rel });
  else c.get("sse").publish(c.get("workspace").slug, { type: "change", path: rel });
  return c.json({ content: null, commit: null });
});

files.get("/:owner/:repo/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel) return c.json(...bad("path required"));
  const { backend, owner, repo } = c.get("repoCtx");
  const ref = refFromQuery(c);
  if (!validRequestedBranch(ref)) return c.json(...bad("valid branch name required"));
  let branchInfo: Awaited<ReturnType<typeof backend.getBranch>> | null = null;
  try {
    branchInfo = await backend.getBranch(owner, repo, ref);
    const snapshotRef = branchInfo?.commit?.id ?? ref;
    const read = await backend.readFile(owner, repo, snapshotRef, rel);
    if (!read) throw new WorkspaceBackendError(404, "not_found", `not found: ${rel}`);
    return c.json({ content: read.content, sha: read.sha });
  } catch (err) {
    if (err instanceof WorkspaceBackendError && err.status === 404 && ref !== "main") {
      // File not on the branch — fall back to main so the editor can still
      // show the canonical version.
      try {
        const mainInfo = await backend.getBranch(owner, repo, "main");
        const mainRef = mainInfo?.commit?.id ?? "main";
        const read = await backend.readFile(owner, repo, mainRef, rel);
        if (!read) return c.json(...notFound());
        return c.json({
          content: read.content,
          sha: branchInfo ? null : read.sha,
          source_ref: "main",
          source_sha: read.sha,
        });
      } catch (err2) {
        if (err2 instanceof WorkspaceBackendError && err2.status === 404)
          return c.json(...notFound());
        throw err2;
      }
    }
    if (err instanceof WorkspaceBackendError && err.status === 404)
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
  if (branch === "main" && !isLocalMode(c))
    return c.json(...bad("branch required (cannot write to main)"));
  const body = (await c.req.json().catch(() => null)) as {
    content?: string;
    previous_path?: string;
    expected_sha?: string | null;
    expected_source_sha?: string;
    reset_edit_branch?: boolean;
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

  if (body.reset_edit_branch === true && !await resetRetiredEditBranch(c, branch)) {
    return c.json(...conflict("edit branch is active; reload and retry"));
  }
  await ensureBranch(c, branch);
  const { backend, owner, repo } = c.get("repoCtx");
  const ws = c.get("workspace");
  const db = c.get("db");
  const hub = c.get("sse");

  const isRename = Boolean(previousRel && previousRel !== rel);
  const existing = await backend.getFileMeta(owner, repo, branch, rel);
  if (isRename && existing)
    return c.json(...conflict("destination already exists"));
  const previous = isRename ? await backend.getFileMeta(owner, repo, branch, previousRel as string) : null;
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
  // verbatim and never indexed (mirrors the web editor writeFile path). The
  // workspace's declared markdown format is passed explicitly while the API
  // still carries the historical format field.
  const isMarkdown = fileKindForPath(rel) === "markdown";
  let mainSourceMeta: Awaited<ReturnType<typeof backend.getFileMeta>> | undefined;
  if (isRename && previous && isMarkdown && fileKindForPath(previousRel as string) === "markdown") {
    mainSourceMeta = await backend.getFileMeta(owner, repo, "main", previousRel as string);
  }
  const replacePath = isRename && previous && mainSourceMeta === null
    ? previousRel as string
    : undefined;
  const plan = isMarkdown
    ? planIndexPage(db, {
        workspaceSlug: ws.slug,
        filePath: rel,
        bodyText: body.content,
        replacePath,
      })
    : null;
  const finalContent = plan?.rewrittenContent ?? body.content;
  const finalContentSha = gitBlobHash(Buffer.from(finalContent, "utf8"));
  const successBody = (sha: string | null, commit?: string | null) => ({
    ok: true as const,
    branch,
    meta: { id: plan?.cosheafId ?? null, title: plan?.title },
    content: plan?.rewrittenContent ?? undefined,
    ...(commit !== undefined ? { commit } : {}),
    sha,
  });
  const readCurrentMetaForAlreadyApplied = async () =>
    backend.getFileMeta(owner, repo, branch, rel).catch((err: unknown) => {
      if (err instanceof WorkspaceBackendError && (err.code === "not_found" || err.code === "ref_missing")) return null;
      throw err;
    });
  const currentWriteAlreadyApplied = (current: { sha: string } | null): Response | null => {
    if (isRename || current?.sha !== finalContentSha) return null;
    indexLocalWrite(isLocalMode(c), db, ws.slug, plan);
    if (rel === REPO_CONFIG_PATH) bustRepoConfig(db, ws.slug, branch);
    invalidateBranchReadCaches(owner, repo, branch);
    if (isLocalMode(c)) publishLocalFileMutationEvents(c, ws.slug, { action: "changed", path: rel });
    return c.json(successBody(current.sha, null));
  };
  const localAnnotationEntry = isLocalMode(c) && isRename && previousRel && previousRel !== rel
    ? resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry ?? null
    : null;
  if (localAnnotationEntry) {
    try {
      assertLocalAnnotationsReadable(localAnnotationEntry);
    } catch (err) {
      const sidecar = localAnnotationSidecarConflict(err);
      if (sidecar) return c.json(...conflict(sidecar.error, sidecar));
      throw err;
    }
  }
  // Compare-and-set: if the caller declared the blob sha its edit was based on and
  // the branch has since moved, reject before writing so a concurrent edit isn't
  // silently clobbered (#92). On a rename the edit was based on the SOURCE blob,
  // not the (normally empty) destination — compare against the source.
  const casMeta = isRename ? previous : existing;
  const casPath = isRename ? (previousRel as string) : rel;
  if (expectedSha !== undefined && (casMeta?.sha ?? null) !== expectedSha) {
    const alreadyApplied = currentWriteAlreadyApplied(casMeta);
    if (alreadyApplied) return alreadyApplied;
    return c.json(...(await staleShaConflict(backend, owner, repo, branch, casPath, expectedSha)));
  }
  if (expectedSourceSha !== undefined && !casMeta?.sha) {
    const sourceMeta = mainSourceMeta ?? await backend.getFileMeta(owner, repo, "main", casPath);
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
    r = await backend.putFile(owner, repo, {
      branch,
      path: rel,
      content: finalContent,
      sha: existing?.sha,
      message: isRename ? `rename ${previousRel} to ${rel}` : existing ? `update ${rel}` : `create ${rel}`,
    });
  } catch (err) {
    // A concurrent writer landed a commit between our getFileMeta read and the
    // putFile. The backend reports that as `stale_sha`; surface a typed,
    // recoverable conflict instead of a bare 502 (#92).
    if (isStaleShaConflict(err)) {
      const alreadyApplied = currentWriteAlreadyApplied(await readCurrentMetaForAlreadyApplied());
      if (alreadyApplied) return alreadyApplied;
      return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, expectedSha)));
    }
    throw err;
  }
  if (isRename && previous) {
    try {
      await backend.deleteFile(owner, repo, {
        branch,
        path: previousRel as string,
        sha: previous.sha,
        message: `remove ${previousRel} after rename`,
      });
    } catch (err) {
      if (!isStaleShaConflict(err)) throw err;
      try {
        await rollbackCreatedRenameDestination(backend, owner, repo, branch, rel, r.content?.sha);
      } catch (rollbackErr) {
        invalidateBranchReadCaches(owner, repo, branch);
        throw new Error(`rename rollback failed for ${rel}: ${(rollbackErr as Error).message}`);
      }
      invalidateBranchReadCaches(owner, repo, branch);
      return c.json(...(await staleShaConflict(backend, owner, repo, branch, previousRel as string, expectedSha)));
    }
  }
  // The sidecar is branchless and mirrors Forgejo main. Branch writes still use
  // the plan for frontmatter/id rewriting and response metadata, but must not
  // publish unmerged branch content into search/backlinks/tree doc metadata
  // (webhooks/reindex reconcile main). Local Workbench is the exception — see
  // indexLocalWrite — committing now and cleaning up a renamed-away page.
  indexLocalWrite(isLocalMode(c), db, ws.slug, plan, isRename && previousRel && previousRel !== rel ? previousRel : undefined);
  if (localAnnotationEntry && previousRel) {
    const moved = moveLocalAnnotationsPath(localAnnotationEntry, previousRel, rel);
    if (moved > 0) publishLocalAnnotationEvent(c, localAnnotationEntry, {
      action: "moved",
      path: rel,
      previous_path: previousRel,
      count: moved,
    });
  }
  // #182: a cosheaf.yaml write through the typed route busts its cached config
  // for this branch so the change is read-after-write consistent (the webhook
  // only reconciles main; external non-main pushes reconcile on reindex).
  if (rel === REPO_CONFIG_PATH || previousRel === REPO_CONFIG_PATH) bustRepoConfig(db, ws.slug, branch);
  invalidateBranchReadCaches(owner, repo, branch);
  if (isLocalMode(c)) {
    publishLocalFileMutationEvents(c, ws.slug, isRename
      ? { action: "moved", path: rel, previous_path: previousRel as string }
      : { action: "changed", path: rel });
  } else {
    if (isRename) hub.publish(ws.slug, { type: "change", path: previousRel as string });
    hub.publish(ws.slug, { type: "change", path: rel });
  }
  const writtenSha = r.content?.sha ?? (await backend.getFileMeta(owner, repo, branch, rel).catch(() => null))?.sha ?? null;
  return c.json(successBody(writtenSha, r.commit?.sha));
});

files.post("/:owner/:repo/assets", async (c) => {
  const branch = c.req.query("branch")?.trim();
  if (!branch)
    return c.json(...bad("branch required"));
  if (!validBranchName(branch))
    return c.json(...bad("valid branch name required"));
  if (branch === "main" && !isLocalMode(c))
    return c.json(...bad("branch required (cannot upload assets to main)"));
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return c.json(...bad("file field required"));
  if (file.size > MAX_ASSET_BYTES)
    return c.json(...bad(`asset exceeds ${MAX_ASSET_DISPLAY}`));
  const { backend, owner, repo } = c.get("repoCtx");
  await ensureBranch(c, branch);
  // Keep a readable basename plus a short random suffix so simultaneous uploads
  // of the same filename don't collide. Git still deduplicates blobs server-side.
  const safeName = predictableUploadName(file.name);
  const rand = Math.random().toString(36).slice(2, 10);
  const repoConfig = await loadRepoConfig(c.get("db"), backend, owner, repo, branch);
  const assetPath = `${repoConfig.assetFolder}/${safeName.stem}-${rand}${safeName.ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await backend.putFileBytes(owner, repo, {
    branch,
    path: assetPath,
    content: bytes,
    message: `upload ${safeName.stem}${safeName.ext}`,
  });
  invalidateBranchReadCaches(owner, repo, branch);
  if (isLocalMode(c)) publishLocalFileMutationEvents(c, c.get("workspace").slug, { action: "changed", path: assetPath });
  else c.get("sse").publish(c.get("workspace").slug, { type: "change", path: assetPath });
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

files.delete("/:owner/:repo/file", async (c) => {
  const rel = safeRel(c.req.query("path"));
  if (!rel || !isEditableTextFile(rel))
    return c.json(...bad("invalid path"));
  const branch = refFromQuery(c);
  if (!validRequestedBranch(branch)) return c.json(...bad("valid branch name required"));
  if (branch === "main" && !isLocalMode(c))
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
  const { backend, owner, repo } = c.get("repoCtx");
  const meta = await backend.getFileMeta(owner, repo, branch, rel);
  if (!meta) return c.json(...notFound());
  if (expectedSha !== undefined && meta.sha !== expectedSha) {
    return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, expectedSha)));
  }
  try {
    await backend.deleteFile(owner, repo, {
      branch,
      path: rel,
      sha: meta.sha,
      message: `delete ${rel}`,
    });
  } catch (err) {
    if (isStaleShaConflict(err)) {
      return c.json(...(await staleShaConflict(backend, owner, repo, branch, rel, expectedSha)));
    }
    throw err;
  }
  const db = c.get("db");
  const ws = c.get("workspace");
  indexLocalDelete(isLocalMode(c), db, ws.slug, rel);
  if (rel === REPO_CONFIG_PATH) bustRepoConfig(db, ws.slug, branch);
  invalidateBranchReadCaches(owner, repo, branch);
  if (isLocalMode(c)) publishLocalFileMutationEvents(c, ws.slug, { action: "removed", path: rel });
  else c.get("sse").publish(ws.slug, { type: "change", path: rel });
  return c.json({ ok: true, branch });
});

// Read surface (xref/suggest/search/tags/backlinks/validation) is registered
// onto this same app from files-refs.ts.
registerFileRefRoutes(files);

files.get("/:owner/:repo/events", (c) => streamHubChannel(c, c.get("sse"), c.get("workspace").slug));
