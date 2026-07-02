import type { ActivityRow } from "../shared/issues.js";
import type { ForgejoActivity } from "./forgejo-types.js";
import { toEpochMs } from "./forgejo-types.js";

export function forgeActivitiesToRows(activities: readonly ForgejoActivity[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const activity of activities) {
    const current = toActivityRow(activity);
    const previous = rows.at(-1);
    if (previous && canCollapse(previous, current)) {
      previous.repeat_count += 1;
      continue;
    }
    rows.push(current);
  }
  return rows;
}

export function branchFromRef(ref: string | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function parseActivityContent(content: string | undefined): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch (_err) {
    return null;
  }
}

function activityCommitRef(value: unknown): { sha: string; message: string } | null {
  if (!isRecord(value)) return null;
  const commits = value.Commits;
  if (!Array.isArray(commits)) return null;
  for (const commit of commits) {
    if (!isRecord(commit) || typeof commit.Sha1 !== "string") continue;
    return { sha: commit.Sha1, message: typeof commit.Message === "string" ? commit.Message : "" };
  }
  return null;
}

function toActivityRow(activity: ForgejoActivity): ActivityRow {
  const parsed = parseActivityContent(activity.content);
  const commit = activityCommitRef(parsed);
  let refIndex: number | null = null;
  let refText: string | null = null;
  if (Array.isArray(parsed) && parsed.length > 0) {
    refIndex = positiveInt(parsed[0]);
    if (parsed.length > 1 && typeof parsed[1] === "string") refText = parsed[1];
  } else if (typeof parsed === "string") {
    refIndex = positiveInt(parsed);
  }
  refIndex ??= indexFromApiUrl(activity.comment?.issue_url);
  return {
    id: activity.id,
    op_type: activity.op_type,
    author_username: activity.act_user?.login ?? null,
    ref_index: refIndex,
    ref_name: activity.ref_name ?? null,
    ref_text: refText,
    commit_sha: commit?.sha ?? null,
    commit_message: commit?.message ?? null,
    repeat_count: 1,
    created_at: toEpochMs(activity.created),
  };
}

function canCollapse(a: ActivityRow, b: ActivityRow): boolean {
  if (!isCollapsibleEditCommit(a) || !isCollapsibleEditCommit(b)) return false;
  return (a.author_username ?? "") === (b.author_username ?? "") && branchFromRef(a.ref_name ?? undefined) === branchFromRef(b.ref_name ?? undefined);
}

function isCollapsibleEditCommit(activity: ActivityRow): boolean {
  if (activity.op_type !== "commit_repo") return false;
  const branch = branchFromRef(activity.ref_name ?? undefined);
  return Boolean(branch && branch !== "main" && branch !== "master");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function indexFromApiUrl(url: string | undefined): number | null {
  const match = url?.match(/\/issues\/(\d+)(?:$|[#?])/);
  return positiveInt(match?.[1]);
}
