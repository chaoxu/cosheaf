import type Database from "better-sqlite3";
import { isCoverifyChatEnabled } from "./coverify-cli.js";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import { ForgejoError } from "./forgejo.js";
import { deletePage, indexPage } from "./indexer.js";
import { clearRepoConfig } from "./repo-config.js";
import type { User } from "./users.js";
import { workspaceSlug } from "../shared/conventions.js";
import {
  DEFAULT_CREATE_FORMAT_ID,
  type DocumentFormatId,
  documentFormatFromTopics,
  isFormatTopic,
  normalizeDocumentFormatId,
  topicForDocumentFormat,
} from "../shared/document-format.js";

// Forgejo events we subscribe to. The cosheaf webhook handler in
// `server/routes/webhooks.ts` switches on these exact strings — if you
// add to this list, add a handler branch too, or Forgejo will keep
// re-delivering an event we always 200-noop.
const WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "issues",
  "issue_comment",
];

// A workspace is identified by (owner, repo) — any Forgejo user or org can
// own workspaces. The slug is the `owner/repo` full name; the display name
// lives in the Forgejo repo description; the markdown format lives in a
// Forgejo repo topic. There is no SQLite `workspaces` row — sidecar tables
// key off the slug directly.
export interface Workspace {
  owner: string;
  repo: string;
  slug: string;
  defaultMdFormat: DocumentFormatId;
}

export interface WorkspaceMarkdownDrift {
  sidecarPaths: string[];
  forgejoPaths: string[];
  onlySidecar: string[];
  onlyForgejo: string[];
  inSync: number;
}

export interface ProvisionWorkspaceOptions {
  owner: string;
  repo: string;
  name: string;
  user: User;
  forgejoUsername: string;
  // How to create a missing repo. "user-pat" (routes): the supplied client is
  // the creator's PAT — create under their account, or via the org endpoint
  // when owner differs from the creator. "admin" (CLI/seed): the supplied
  // client is site-admin — create on behalf of `owner` via the admin API.
  provisionVia: "user-pat" | "admin";
  allowExistingLocal?: boolean;
  rollbackCreatedRepoOnLocalFailure?: boolean;
  defaultMdFormat?: string;
}

export interface ProvisionWorkspaceResult {
  workspace: Workspace;
  repoExisted: boolean;
  createdRepo: boolean;
}

export async function provisionWorkspace(
  db: Database.Database,
  forgejo: Forgejo,
  config: Config,
  options: ProvisionWorkspaceOptions,
): Promise<ProvisionWorkspaceResult> {
  const { owner, repo: repoName } = options;
  let repoExisted = false;
  let createdRepo = false;

  const existingRepo = await forgejo.getRepo(owner, repoName);
  if (existingRepo) {
    repoExisted = true;
  } else {
    const repoOpts = {
      name: repoName,
      description: options.name,
      private: true,
      auto_init: true,
      default_branch: "main",
    };
    if (options.provisionVia === "admin") {
      await forgejo.createRepoForUser(owner, repoOpts);
    } else if (owner === options.forgejoUsername) {
      await forgejo.createUserRepo(repoOpts);
    } else {
      await forgejo.createOrgRepo(owner, repoOpts);
    }
    createdRepo = true;
  }

  const rollback = async (err: unknown): Promise<never> => {
    if (createdRepo && options.rollbackCreatedRepoOnLocalFailure) {
      try {
        await forgejo.deleteRepo(owner, repoName);
      } catch (rollbackErr) {
        console.warn(`rollback delete failed: ${(rollbackErr as Error).message}`);
      }
    }
    throw err;
  };

  let workspace: Workspace;
  try {
    const formatId = normalizeDocumentFormatId(
      options.defaultMdFormat ?? DEFAULT_CREATE_FORMAT_ID,
    );
    await setWorkspaceFormatTopic(forgejo, owner, repoName, formatId);
    workspace = { owner, repo: repoName, slug: workspaceSlug(owner, repoName), defaultMdFormat: formatId };
  } catch (err) {
    return rollback(err);
  }

  try {
    // The seed/initial-file commits below run as whoever the `forgejo` client
    // authenticates as — the creator's PAT for "user-pat", the site-admin
    // identity for "admin". That committer must be on the push whitelist or
    // branch protection rejects the initial commit to main. For "user-pat"
    // the committer is the creator (their PAT); only the "admin" path needs a
    // lookup to discover the site-admin identity.
    const committer =
      options.provisionVia === "admin"
        ? (await forgejo.getCurrentUser()).login
        : options.forgejoUsername;
    await ensureWorkspacePermissions(forgejo, config, owner, repoName, options.forgejoUsername, committer);
    // Webhook registration is needed only for workspaces whose sidecar we
    // reconcile from Forgejo events. Passthrough workspaces don't index
    // into the sidecar (no doc_map / FTS / backlinks usage), so there's
    // nothing to reconcile and no SSE event worth firing. Skip the hook
    // for them; coflat workspaces still get one and roll back on failure.
    if (workspace.defaultMdFormat !== "forgejo-passthrough") {
      await ensureWorkspaceWebhookOrThrow(forgejo, config, owner, repoName);
    }
    if (!repoExisted) {
      await ensureWorkspaceFile(forgejo, owner, repoName, {
        path: ".gitattributes",
        content: "*.md text eol=lf -text\n",
        message: "chore: lock byte-exactness for .md",
      });
    }
  } catch (err) {
    return rollback(err);
  }

  try {
    await reindexWorkspaceFromForgejo(db, forgejo, workspace);
  } catch (err) {
    console.warn(`workspace reindex failed: ${(err as Error).message}`);
  }

  return { workspace, repoExisted, createdRepo };
}

// Replace any existing cosheaf-format-* topics on the repo with exactly the
// one that selects `formatId`. Other repo topics (user-set) are preserved.
export async function setWorkspaceFormatTopic(
  forgejo: Forgejo,
  owner: string,
  repoName: string,
  formatId: DocumentFormatId,
): Promise<void> {
  const existing = await forgejo.listRepoTopics(owner, repoName);
  const preserved = existing.filter((t) => !isFormatTopic(t));
  const target = [...preserved, topicForDocumentFormat(formatId)];
  await forgejo.replaceRepoTopics(owner, repoName, target);
}

export async function readWorkspaceFormatFromTopics(
  forgejo: Forgejo,
  owner: string,
  repoName: string,
): Promise<DocumentFormatId> {
  const topics = await forgejo.listRepoTopics(owner, repoName);
  return documentFormatFromTopics(topics);
}

export async function getWorkspaceMarkdownDrift(
  db: Database.Database,
  forgejo: Forgejo,
  workspace: Pick<Workspace, "owner" | "repo" | "slug">,
): Promise<WorkspaceMarkdownDrift> {
  const sidecarPaths = (
    db
      .prepare("SELECT forgejo_id AS path FROM doc_map WHERE workspace_slug = ?")
      .all(workspace.slug) as Array<{ path: string }>
  )
    .map((r) => r.path)
    .sort();
  const tree = await forgejo.getTree(workspace.owner, workspace.repo, "main", true);
  const forgejoPaths = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => e.path)
    .sort();
  const sidecarSet = new Set(sidecarPaths);
  const forgejoSet = new Set(forgejoPaths);
  const onlySidecar = sidecarPaths.filter((p) => !forgejoSet.has(p));
  const onlyForgejo = forgejoPaths.filter((p) => !sidecarSet.has(p));
  const inSync = sidecarPaths.filter((p) => forgejoSet.has(p)).length;
  return {
    sidecarPaths,
    forgejoPaths,
    onlySidecar,
    onlyForgejo,
    inSync,
  };
}

export async function ensureWorkspacePermissions(
  forgejo: Forgejo,
  config: Config,
  owner: string,
  repoName: string,
  forgejoUsername: string,
  committer: string = forgejoUsername,
): Promise<void> {
  if (forgejoUsername !== owner) {
    try {
      // The creator becomes the workspace owner — Forgejo "admin" so they can
      // change settings (e.g. branch protection) and direct-merge.
      await forgejo.addCollaborator(owner, repoName, forgejoUsername, "admin");
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 409)) {
        console.warn(`addCollaborator failed: ${(err as Error).message}`);
      }
    }
  }

  if (isCoverifyChatEnabled(config) && config.coverifyBotLogin !== owner) {
    try {
      // The Coverify chat bot needs write access in every workspace so it can
      // read chat threads and post replies; otherwise chats there sit at
      // "thinking…" forever (the reply worker can't see workspaces it isn't on).
      await forgejo.addCollaborator(owner, repoName, config.coverifyBotLogin, "write");
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 409)) {
        console.warn(`coverify bot addCollaborator failed: ${(err as Error).message}`);
      }
    }
  }

  try {
    // The whitelist needs the repo owner (direct-push from the UI), the
    // creator when they differ (org-owned repos created by a member), and the
    // identity committing the initial seed files (the site-admin in CLI/seed
    // provisioning) so branch protection doesn't reject that first commit.
    const whitelist = Array.from(new Set([owner, forgejoUsername, committer]));
    const existing = await forgejo.getBranchProtection(owner, repoName, "main");
    if (!existing) {
      await forgejo.createBranchProtection(owner, repoName, {
        branch_name: "main",
        required_approvals: 1,
        push_whitelist_usernames: whitelist,
      });
    } else {
      await forgejo.patchBranchProtectionPushWhitelist(owner, repoName, "main", whitelist);
    }
  } catch (err) {
    console.warn(`branch protection setup failed: ${(err as Error).message}`);
  }
}

async function ensureWorkspaceWebhookOrThrow(
  forgejo: Forgejo,
  config: Config,
  owner: string,
  repoName: string,
): Promise<void> {
  const hooks = await forgejo.listRepoHooks(owner, repoName);
  const hasOurHook = hooks.some((h) => Array.isArray(h.events) && h.events.includes("push"));
  if (!hasOurHook) {
    await forgejo.createRepoHook(
      owner,
      repoName,
      config.webhookUrl,
      config.webhookSecret,
      WEBHOOK_EVENTS,
    );
  }
}

export async function ensureWorkspaceFile(
  forgejo: Forgejo,
  owner: string,
  repoName: string,
  file: { path: string; content: string | Buffer; message: string },
): Promise<boolean> {
  const meta = await forgejo.getFileMeta(owner, repoName, "main", file.path);
  if (meta) return false;
  if (Buffer.isBuffer(file.content)) {
    await forgejo.putFileBytes(owner, repoName, {
      branch: "main",
      path: file.path,
      content: file.content,
      message: file.message,
    });
    return true;
  }
  await forgejo.putFile(owner, repoName, {
    branch: "main",
    path: file.path,
    content: file.content,
    message: file.message,
  });
  return true;
}

export async function reindexWorkspaceFromForgejo(
  db: Database.Database,
  forgejo: Forgejo,
  workspace: { owner: string; repo: string; slug: string; defaultMdFormat?: DocumentFormatId },
): Promise<number> {
  const seen = new Set<string>();
  // #182: drop cached cosheaf.yaml config so it rebuilds from Forgejo on next
  // render (the file is authoritative; the sidecar only caches it).
  clearRepoConfig(db, workspace.slug);
  const tree = await forgejo.getTree(workspace.owner, workspace.repo, "main", true);
  const mdPaths = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => e.path);
  // Fetch all markdown bodies in parallel — each getRawFile is independent
  // and the indexPage write that follows is local.
  const bodies = await Promise.all(
    mdPaths.map((path) =>
      forgejo
        .getRawFile(workspace.owner, workspace.repo, "main", path)
        .then((body) => ({ path, body })),
    ),
  );
  for (const { path, body } of bodies) {
    indexPage(db, {
      workspaceSlug: workspace.slug,
      filePath: path,
      bodyText: body,
      formatId: workspace.defaultMdFormat,
    });
    seen.add(path);
  }

  const indexed = db
    .prepare("SELECT forgejo_id FROM doc_map WHERE workspace_slug = ?")
    .all(workspace.slug) as Array<{ forgejo_id: string }>;
  for (const row of indexed) {
    if (!seen.has(row.forgejo_id)) deletePage(db, workspace.slug, row.forgejo_id);
  }
  return seen.size;
}
