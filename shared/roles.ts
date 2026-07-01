// Workspace role vocabulary. Mirrors Forgejo's repo-collaborator permission
// levels exactly so cosheaf doesn't fork the access model. Middleware derives
// `ws.role` from Forgejo's
// `GET /repos/{owner}/{repo}/collaborators/{user}/permission` endpoint.
//
//   admin  → workspace owner (settings; direct merge via Forgejo branch
//            protection push whitelist).
//   write  → contributor; can push branches, open PRs, leave reviews,
//            comment. APPROVE counts toward required-approvals threshold.
//   read   → view-only.

export const ROLES = ["admin", "write", "read"] as const;
export type Role = (typeof ROLES)[number];

// Rank for "at least this level" comparisons (admin > write > read). Single
// owner for role ordering so a future intermediate level (e.g. Forgejo's
// "maintain") can't make affordance-visibility and authorization disagree.
const ROLE_RANK: Record<Role, number> = { read: 0, write: 1, admin: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

// Whether a role may perform write actions (push branches, open PRs, comment,
// review). The one owner of the write gate — replaces the two contradictory
// encodings `role === "write" || role === "admin"` and `role !== "read"`.
export function canWrite(role: Role): boolean {
  return roleAtLeast(role, "write");
}
