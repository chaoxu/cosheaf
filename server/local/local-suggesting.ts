import { Hono } from "hono";
import { isEditableTextFile, fileKindForPath } from "../../shared/file-kind.js";
import {
  revertSuggestingHunk,
  suggestingHunks,
  type SuggestingHunk,
} from "../../shared/suggesting-diff.js";
import { indexLocalWrite, planIndexPage } from "../indexer.js";
import { requireAuth, requireMembership, requireWriteOnMutation } from "../middleware.js";
import { readJsonObject } from "../routes/query-params.js";
import { bad, conflict, notFound } from "../routes/responses.js";
import { safeRel } from "../routes/files.js";
import type { AppEnv } from "../types.js";
import { WorkspaceBackendError } from "../workspace-backend.js";
import { invalidateBranchTree } from "../tree-cache.js";
import { friendlyLine } from "./git-errors.js";
import { publishLocalFileMutationEvents, publishLocalGitEvent } from "./local-events.js";
import { resolveLocalWorkspace } from "./local-mode.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

export const localSuggesting = new Hono<AppEnv>();
localSuggesting.use("*", requireAuth);
localSuggesting.use("/:owner/:repo/*", requireMembership());
localSuggesting.use("/:owner/:repo/*", requireWriteOnMutation);

function localSuggestingEntry(c: import("hono").Context<AppEnv>): WorkspaceEntry | null {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  if (!owner || !repo) return null;
  return resolveLocalWorkspace(c.get("localRegistry"), owner, repo)?.entry ?? null;
}

function jsonPath(value: unknown): string | null {
  return typeof value === "string" ? safeRel(value) : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function jsonHunk(value: unknown): SuggestingHunk | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const oldStart = positiveInt(raw.old_start);
  const oldLines = nonNegativeInt(raw.old_lines);
  const newStart = positiveInt(raw.new_start);
  const newLines = nonNegativeInt(raw.new_lines);
  if (oldStart === null || oldLines === null || newStart === null || newLines === null) return null;
  if (oldLines === 0 && newLines === 0) return null;
  const kind = oldLines === 0 ? "insert" : newLines === 0 ? "delete" : "change";
  return {
    id: `${oldStart}:${oldLines}:${newStart}:${newLines}`,
    kind,
    old_start: oldStart,
    old_lines: oldLines,
    new_start: newStart,
    new_lines: newLines,
  };
}

function gitError(err: unknown): readonly [{ error: string; code?: string }, 400 | 404 | 409] | null {
  if (!(err instanceof WorkspaceBackendError)) return null;
  if (err.status === 404) return notFound(err.message);
  if (err.status === 409) return conflict(err.message);
  return bad(err.message);
}

async function currentBranch(entry: WorkspaceEntry): Promise<string> {
  return await entry.backend.currentBranch() ?? "main";
}

localSuggesting.get("/:owner/:repo/local-suggesting/base", async (c) => {
  const entry = localSuggestingEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const path = safeRel(c.req.query("path"));
  if (!path || !isEditableTextFile(path)) return c.json(...bad("valid editable path required"));
  try {
    const head = await entry.backend.getHeadFile(path);
    return c.json({ path, base_text: head.content, head_sha: head.head_sha });
  } catch (err) {
    const mapped = gitError(err);
    if (mapped) return c.json(...mapped);
    throw err;
  }
});

localSuggesting.post("/:owner/:repo/local-suggesting/revert", async (c) => {
  const entry = localSuggestingEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const body = await readJsonObject(c.req);
  const path = jsonPath(body.path);
  const hunk = jsonHunk(body.hunk);
  if (!path || !isEditableTextFile(path)) return c.json(...bad("valid editable path required"));
  if (!hunk) return c.json(...bad("valid hunk required"));
  try {
    const head = await entry.backend.getHeadFile(path);
    const current = await entry.backend.getRawFile(entry.identity.owner, entry.identity.repo, "WORKTREE", path);
    const next = revertSuggestingHunk(head.content, current, hunk);
    if (next === null) return c.json(...conflict("suggesting hunk is stale; reload the file and retry"));
    const meta = await entry.backend.getFileMeta(entry.identity.owner, entry.identity.repo, "WORKTREE", path);
    if (!meta) return c.json(...notFound("file not found"));
    const content = next;
    const plan = fileKindForPath(path) === "markdown"
      ? planIndexPage(c.get("db"), {
          workspaceSlug: entry.slug,
          filePath: path,
          bodyText: content,
          formatId: entry.identity.defaultMdFormat,
        })
      : null;
    const branch = await currentBranch(entry);
    const written = await entry.backend.putFile(entry.identity.owner, entry.identity.repo, {
      branch,
      path,
      content,
      sha: meta.sha,
      message: `revert hunk in ${path}`,
    });
    indexLocalWrite(true, c.get("db"), entry.slug, plan);
    invalidateBranchTree(entry.identity.owner, entry.identity.repo, branch);
    publishLocalFileMutationEvents(c, entry, { action: "changed", path });
    return c.json({
      path,
      content,
      sha: written.content?.sha ?? null,
      hunks: suggestingHunks(head.content, content),
      base_text: head.content,
      head_sha: head.head_sha,
    });
  } catch (err) {
    const mapped = gitError(err);
    if (mapped) return c.json(...mapped);
    throw err;
  }
});

localSuggesting.post("/:owner/:repo/local-suggesting/checkpoint", async (c) => {
  const entry = localSuggestingEntry(c);
  if (!entry) return c.json({ error: "workspace not found" }, 404);
  const body = await readJsonObject(c.req);
  const path = jsonPath(body.path);
  if (!path || !isEditableTextFile(path)) return c.json(...bad("valid editable path required"));
  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const message = `Checkpoint: ${rawMessage || path}`;
  try {
    const sha = await entry.backend.commitPaths(message, [path]);
    if (sha) publishLocalGitEvent(c, entry, { action: "committed", sha, paths: [path] });
    else publishLocalGitEvent(c, entry, { action: "status_changed", paths: [path] });
    const head = await entry.backend.getHeadFile(path);
    return c.json({ path, commit_sha: sha, base_text: head.content, head_sha: head.head_sha });
  } catch (err) {
    const mapped = gitError(err);
    if (mapped) return c.json(...mapped);
    return c.json(...bad(friendlyLine(err)));
  }
});
