import type { Forgejo } from "./forgejo.js";
import type { Role } from "../shared/roles.js";

export async function setWorkspaceMember(args: {
  forgejo: Forgejo;
  owner: string;
  repo: string;
  username: string;
  role: Role;
}): Promise<void> {
  const { forgejo, owner, repo, username, role } = args;

  // Forgejo is the source of truth for membership. Cosheaf only mirrors the
  // extra branch-protection convention that workspace admins may direct-push.
  await forgejo.addCollaborator(owner, repo, username, role);

  const bp = await forgejo.getBranchProtection(owner, repo, "main");
  const current =
    (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
  const onList = current.includes(username);

  if (role === "admin" && !onList) {
    await forgejo.patchBranchProtectionPushWhitelist(owner, repo, "main", [...current, username]);
  } else if (role !== "admin" && onList) {
    await forgejo.patchBranchProtectionPushWhitelist(
      owner,
      repo,
      "main",
      current.filter((u) => u !== username),
    );
  }
}
