import type { WorkspaceBackend, WsPull } from "./workspace-backend.js";

const RETIRED_BRANCH_PULL_LIMIT = 50;

interface RetiredDefaultEditBranchOptions {
  backend: Pick<WorkspaceBackend, "listPulls">;
  owner: string;
  repo: string;
  branch: string;
  defaultEditBranch: string;
}

export async function isRetiredDefaultEditBranch(opts: RetiredDefaultEditBranchOptions): Promise<boolean> {
  if (opts.branch !== opts.defaultEditBranch) return false;
  const isMatchingUnmergedPull = (pull: WsPull): boolean =>
    pull.head.ref === opts.branch && pull.base.ref === "main" && !pull.merged;
  const openPulls = await opts.backend.listPulls(opts.owner, opts.repo, "open", { limit: RETIRED_BRANCH_PULL_LIMIT }).catch(() => null);
  if (openPulls === null || openPulls.some(isMatchingUnmergedPull)) return false;
  const closedPulls = await opts.backend.listPulls(opts.owner, opts.repo, "closed", { limit: RETIRED_BRANCH_PULL_LIMIT }).catch(() => null);
  if (closedPulls === null) return false;
  const retiredPulls = closedPulls.filter(isMatchingUnmergedPull);
  return retiredPulls.length > 0 && retiredPulls.every((pull) => pull.state === "closed");
}
