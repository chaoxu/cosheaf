import type Database from "better-sqlite3";
import type { Config } from "./db.js";
import type { Forgejo } from "./forgejo.js";
import { ForgejoError } from "./forgejo.js";
import { deletePage, indexPage } from "./indexer.js";
import type { User } from "./users.js";
import {
  DEFAULT_DOCUMENT_FORMAT_ID,
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

// A workspace is now identified only by its slug. The slug equals the
// Forgejo repo name; the display name lives in the Forgejo repo description;
// the markdown format lives in a Forgejo repo topic. There is no SQLite
// `workspaces` row — sidecar tables key off the slug directly.
export interface Workspace {
  slug: string;
  defaultMdFormat: DocumentFormatId;
}

export interface ProvisionWorkspaceOptions {
  slug: string;
  name: string;
  user: User;
  forgejoUsername: string;
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
  const owner = config.forgejoOwner;
  const repoName = options.slug;
  let repoExisted = false;
  let createdRepo = false;

  const existingRepo = await forgejo.getRepo(owner, repoName);
  if (existingRepo) {
    repoExisted = true;
  } else {
    await forgejo.createUserRepo({
      name: repoName,
      description: options.name,
      private: true,
      auto_init: true,
      default_branch: "main",
    });
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
      options.defaultMdFormat ?? DEFAULT_DOCUMENT_FORMAT_ID,
    );
    await setWorkspaceFormatTopic(forgejo, owner, repoName, formatId);
    workspace = { slug: repoName, defaultMdFormat: formatId };
  } catch (err) {
    return rollback(err);
  }

  try {
    await ensureWorkspacePermissions(forgejo, config, repoName, options.forgejoUsername);
    // #64: Webhook registration is needed only for workspaces whose sidecar
    // we reconcile from Forgejo events. Passthrough workspaces don't index
    // into the sidecar (no doc_map / FTS / backlinks usage), so there's
    // nothing to reconcile and no SSE event worth firing. Skip the hook for
    // them; coflat workspaces still get one and roll back on failure.
    if (workspace.defaultMdFormat !== "forgejo-passthrough") {
      await ensureWorkspaceWebhookOrThrow(forgejo, config, repoName);
    }
    if (!repoExisted) {
      await ensureWorkspaceFile(forgejo, config, repoName, {
        path: ".gitattributes",
        content: "*.md text eol=lf -text\n",
        message: "chore: lock byte-exactness for .md",
      });
    }
  } catch (err) {
    return rollback(err);
  }

  try {
    await reindexWorkspaceFromForgejo(db, forgejo, config, workspace);
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

export async function ensureWorkspacePermissions(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
  forgejoUsername: string,
): Promise<void> {
  if (forgejoUsername !== config.forgejoOwner) {
    try {
      // The creator becomes the workspace owner — Forgejo "admin" so they can
      // change settings (e.g. branch protection) and direct-merge.
      await forgejo.addCollaborator(config.forgejoOwner, repoName, forgejoUsername, "admin");
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 409)) {
        console.warn(`addCollaborator failed: ${(err as Error).message}`);
      }
    }
  }

  try {
    // The whitelist needs both the workspace owner (direct-push from the UI)
    // and `config.forgejoOwner` (the admin identity used by provisioning and
    // the webhook handler — without it, ensureWorkspaceFile below can't seed
    // the initial .gitattributes / hello.md to main).
    const whitelist = Array.from(new Set([forgejoUsername, config.forgejoOwner]));
    const existing = await forgejo.getBranchProtection(config.forgejoOwner, repoName, "main");
    if (!existing) {
      await forgejo.createBranchProtection(config.forgejoOwner, repoName, {
        branch_name: "main",
        required_approvals: 1,
        push_whitelist_usernames: whitelist,
      });
    } else {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, repoName, "main", whitelist);
    }
  } catch (err) {
    console.warn(`branch protection setup failed: ${(err as Error).message}`);
  }
}

async function ensureWorkspaceWebhookOrThrow(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
): Promise<void> {
  const hooks = await forgejo.listRepoHooks(config.forgejoOwner, repoName);
  const hasOurHook = hooks.some((h) => Array.isArray(h.events) && h.events.includes("push"));
  if (!hasOurHook) {
    await forgejo.createRepoHook(
      config.forgejoOwner,
      repoName,
      config.webhookUrl,
      config.webhookSecret,
      WEBHOOK_EVENTS,
    );
  }
}

export async function ensureWorkspaceFile(
  forgejo: Forgejo,
  config: Config,
  repoName: string,
  file: { path: string; content: string; message: string },
): Promise<boolean> {
  const meta = await forgejo.getFileMeta(config.forgejoOwner, repoName, "main", file.path);
  if (meta) return false;
  await forgejo.putFile(config.forgejoOwner, repoName, {
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
  config: Config,
  workspace: { slug: string; defaultMdFormat?: string },
): Promise<number> {
  const seen = new Set<string>();
  const tree = await forgejo.getTree(config.forgejoOwner, workspace.slug, "main", true);
  const mdPaths = tree
    .filter((e) => e.type === "blob" && e.path.endsWith(".md"))
    .map((e) => e.path);
  // Fetch all markdown bodies in parallel — each getRawFile is independent
  // and the indexPage write that follows is local.
  const bodies = await Promise.all(
    mdPaths.map((path) =>
      forgejo
        .getRawFile(config.forgejoOwner, workspace.slug, "main", path)
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
