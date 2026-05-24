import type { ForgejoActivity } from "./forgejo-types.js";

export interface ActivityFeedItem {
  activity: ForgejoActivity;
  repeatCount: number;
  commit: { sha: string; message: string } | null;
}

export function collapseNoisyEditBranchCommits(activities: readonly ForgejoActivity[]): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const activity of activities) {
    const commit = activityCommitRef(parseActivityContent(activity.content));
    const current = toFeedItem(activity, commit);
    const previous = items.at(-1);
    if (previous && canCollapse(previous.activity, current.activity)) {
      previous.repeatCount += 1;
      continue;
    }
    items.push(current);
  }
  return items;
}

export function branchFromRef(ref: string | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function parseActivityContent(content: string | undefined): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch (_err) {
    return null;
  }
}

export function activityCommitRef(value: unknown): { sha: string; message: string } | null {
  if (!isRecord(value)) return null;
  const commits = value.Commits;
  if (!Array.isArray(commits)) return null;
  for (const commit of commits) {
    if (!isRecord(commit) || typeof commit.Sha1 !== "string") continue;
    return { sha: commit.Sha1, message: typeof commit.Message === "string" ? commit.Message : "" };
  }
  return null;
}

function toFeedItem(activity: ForgejoActivity, commit: { sha: string; message: string } | null): ActivityFeedItem {
  return { activity, commit, repeatCount: 1 };
}

function canCollapse(a: ForgejoActivity, b: ForgejoActivity): boolean {
  if (!isCollapsibleEditCommit(a) || !isCollapsibleEditCommit(b)) return false;
  return (a.act_user?.login ?? "") === (b.act_user?.login ?? "") && branchFromRef(a.ref_name) === branchFromRef(b.ref_name);
}

function isCollapsibleEditCommit(activity: ForgejoActivity): boolean {
  if (activity.op_type !== "commit_repo") return false;
  const branch = branchFromRef(activity.ref_name);
  return Boolean(branch && branch !== "main" && branch !== "master");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
