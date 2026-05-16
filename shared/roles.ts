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
