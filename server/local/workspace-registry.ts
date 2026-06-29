// The Workbench's workspace registry: the set of on-disk folders the local
// server can open, keyed by their `owner/repo` slug. Replaces the old
// one-folder-per-process model so a single Workbench can switch between projects
// (a personal notes folder, a remote-backed paper repo, …) without relaunching.
//
// Forge-free by construction (server/local/** boundary): each entry talks to its
// working tree via a LocalGitWorkspaceBackend and, at Tier 2, to a remote Cosheaf
// via its typed API client. One shared SQLite sidecar holds every workspace's
// rebuildable index, scoped by the workspace_slug column the schema already has.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { workspaceSlug } from "../../shared/conventions.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { indexCitationFile, indexPage } from "../indexer.js";
import type { LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { type LocalGitRemote, deriveLocalWorkspace } from "./local-workspace.js";
import { type RemotePullClient, RemoteCosheafClient } from "./remote-cosheaf-client.js";

// The fixed single user every local workspace is served as. The Workbench is
// single-person; this handle only colours the sidebar identity and any branch
// naming (writes are direct-mode, so it is otherwise cosmetic).
export const LOCAL_USER = "local";

// One opened folder. `identity` is the existing per-workspace contract the routes
// already consume; `gitRemote` + `remoteClient` add the Tier-2 / display bits.
export interface WorkspaceEntry {
  slug: string;
  // Absolute path to the folder on disk.
  path: string;
  identity: LocalWorkspaceIdentity;
  backend: LocalGitWorkspaceBackend;
  // Working-tree git upstream (display + push target), or null for local-only.
  gitRemote: LocalGitRemote | null;
  // Tier 2 open-PR client (present iff .cosheaf/remote.json configured a token).
  remoteClient?: RemotePullClient;
}

export class WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceEntry>();

  constructor(
    private readonly db: Database.Database,
    private readonly opts: { configPath?: string; user?: string } = {},
  ) {}

  // The fixed local user (see LOCAL_USER); overridable for tests/back-compat.
  get user(): string {
    return this.opts.user ?? LOCAL_USER;
  }

  get(slug: string): WorkspaceEntry | undefined {
    return this.entries.get(slug);
  }

  has(slug: string): boolean {
    return this.entries.has(slug);
  }

  // Stable display order: by slug, so the switcher list doesn't reshuffle.
  list(): WorkspaceEntry[] {
    return [...this.entries.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  // Register a fully-built entry without touching disk or the index. Used by the
  // app's back-compat single-workspace assembly (and internally after building).
  register(entry: WorkspaceEntry): void {
    this.entries.set(entry.slug, entry);
  }

  // Build an entry for a folder from its on-disk identity (git upstream → slug,
  // sidecar remote.json → Tier 2 client). Does not index or persist.
  buildEntry(dir: string): WorkspaceEntry {
    const path = resolve(dir);
    const cfg = deriveLocalWorkspace(path);
    const slug = workspaceSlug(cfg.owner, cfg.repo);
    const identity: LocalWorkspaceIdentity = {
      owner: cfg.owner,
      repo: cfg.repo,
      defaultMdFormat: cfg.defaultMdFormat,
      user: this.user,
      title: cfg.repo,
      // Tier 2: opening a PR needs a configured remote + Cosheaf token.
      canOpenPull: cfg.remote !== null,
    };
    const backend = new LocalGitWorkspaceBackend(path, { pushRemote: cfg.gitRemote?.name });
    const remoteClient = cfg.remote ? new RemoteCosheafClient(cfg.remote.url, cfg.remote.token) : undefined;
    return { slug, path, identity, backend, gitRemote: cfg.gitRemote, remoteClient };
  }

  // Index a workspace's markdown + bib files into the shared sidecar, scoped by
  // its slug. Idempotent: re-indexing replaces the workspace's rows.
  async index(entry: WorkspaceEntry): Promise<{ pages: number; bibs: number }> {
    const { owner, repo, defaultMdFormat } = entry.identity;
    const tree = await entry.backend.getTree(owner, repo, "main", true);
    let pages = 0;
    let bibs = 0;
    for (const node of tree) {
      if (node.type !== "blob") continue;
      if (fileKindForPath(node.path) === "markdown") {
        const content = await entry.backend.getRawFile(owner, repo, "main", node.path);
        indexPage(this.db, { workspaceSlug: entry.slug, filePath: node.path, bodyText: content, formatId: defaultMdFormat });
        pages++;
      } else if (node.path.toLowerCase().endsWith(".bib")) {
        const content = await entry.backend.getRawFile(owner, repo, "main", node.path);
        indexCitationFile(this.db, { workspaceSlug: entry.slug, filePath: node.path, bodyText: content });
        bibs++;
      }
    }
    return { pages, bibs };
  }

  // Open a folder: build its entry, index it, register it, and persist the path.
  // Returns the registered entry (re-opening an existing slug re-indexes it).
  async addFolder(dir: string): Promise<WorkspaceEntry> {
    const entry = this.buildEntry(dir);
    await this.index(entry);
    this.register(entry);
    this.persist();
    return entry;
  }

  // Forget a workspace. Leaves its (rebuildable) index rows in place; they are
  // re-derived if the folder is re-added.
  removeFolder(slug: string): boolean {
    const removed = this.entries.delete(slug);
    if (removed) this.persist();
    return removed;
  }

  // Load persisted folder paths and open each. Missing folders are skipped (the
  // user may have moved/deleted one); they drop out of the persisted set.
  async load(): Promise<void> {
    const paths = this.readConfig();
    for (const path of paths) {
      if (!existsSync(path) || !statSync(path).isDirectory()) continue;
      try {
        const entry = this.buildEntry(path);
        await this.index(entry);
        this.register(entry);
      } catch (_err) {
        // A folder that fails to open (e.g. permissions) shouldn't sink the rest.
      }
    }
    this.persist();
  }

  private readConfig(): string[] {
    const file = this.opts.configPath;
    if (!file || !existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { workspaces?: Array<{ path?: unknown }> };
      return (raw.workspaces ?? []).map((w) => w.path).filter((p): p is string => typeof p === "string");
    } catch (_err) {
      return [];
    }
  }

  private persist(): void {
    const file = this.opts.configPath;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const workspaces = this.list().map((e) => ({ path: e.path }));
    writeFileSync(file, `${JSON.stringify({ workspaces }, null, 2)}\n`);
  }
}
