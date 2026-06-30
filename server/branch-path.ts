export interface BranchName {
  name: string;
}

export interface BranchLister {
  listBranches(owner: string, repo: string): Promise<BranchName[]>;
}

export interface ResolvedBranchPath {
  branch: string;
  path: string;
}

export function resolveBranchPathFromNames(branchNames: string[], rest: string): ResolvedBranchPath | null {
  const clean = rest.replace(/^\/+/, "");
  if (!clean) return { branch: "main", path: "" };

  const sorted = [...branchNames].sort((a, b) => b.length - a.length);
  for (const branch of sorted) {
    if (clean === branch) return { branch, path: "" };
    if (clean.startsWith(`${branch}/`)) return { branch, path: clean.slice(branch.length + 1) };
  }
  const sha = clean.match(/^([0-9a-f]{40})(?:\/(.*))?$/i);
  if (sha) return { branch: sha[1], path: sha[2] ?? "" };
  return null;
}

export async function resolveBranchPath(
  branches: BranchLister,
  owner: string,
  repo: string,
  rest: string,
): Promise<ResolvedBranchPath | null> {
  const names = (await branches.listBranches(owner, repo)).map((branch) => branch.name);
  return resolveBranchPathFromNames(names, rest);
}

// A string shaped like an abbreviated-or-full git commit sha (7-40 hex chars).
// A validation sieve over an opaque id, not a structural parse — gates
// /commit/<sha> pages and rejects the local Workbench's synthetic "WORKTREE" id.
export function isCommitSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

// A syntactically valid Forgejo branch name: the allowlisted charset, no `..`
// traversal, and no leading/trailing slash. Does NOT reject "main" — callers
// that forbid main add `=== "main"` themselves (base branches may be main).
export function validBranchName(value: unknown): value is string {
  return Boolean(
    typeof value === "string" &&
      value &&
      /^[A-Za-z0-9._/-]+$/.test(value) &&
      !value.includes("..") &&
      !value.startsWith("/") &&
      !value.endsWith("/"),
  );
}
