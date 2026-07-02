// The Workbench's workspace registry: the set of on-disk folders the local
// server can open, keyed by their `owner/repo` slug. Replaces the old
// one-folder-per-process model so a single Workbench can switch between projects
// (a personal notes folder, a remote-backed paper repo, …) without relaunching.
//
// Forge-free by construction (server/local/** boundary): each entry talks to its
// working tree via a LocalGitWorkspaceBackend and, at Tier 2, to a remote Cosheaf
// via its typed API client. One shared SQLite sidecar holds every workspace's
// rebuildable index, scoped by the workspace_slug column the schema already has.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { workspaceSlug } from "../../shared/conventions.js";
import { fileKindForPath } from "../../shared/file-kind.js";
import { indexCitationFile, indexPage, pruneWorkspaceIndex } from "../indexer.js";
import type { LocalWorkspaceIdentity } from "../types.js";
import { LocalGitWorkspaceBackend } from "./local-git-backend.js";
import { type LocalGitRemote, type LocalRemote, type WorkbenchProfile, deriveLocalWorkspace } from "./local-workspace.js";

// The fixed single user every local workspace is served as. The Workbench is
// single-person; this handle only colours the sidebar identity and any branch
// naming (writes are direct-mode, so it is otherwise cosmetic).
export const LOCAL_USER = "local";

// One opened folder. `identity` is the existing per-workspace contract the routes
// already consume; `gitRemote` + `remote` add the Tier-2 / display bits.
export interface WorkspaceEntry {
  slug: string;
  // Absolute path to the folder on disk.
  path: string;
  identity: LocalWorkspaceIdentity;
  backend: LocalGitWorkspaceBackend;
  // Tier 2 open-PR config from the gitignored sidecar, if connected.
  remote: LocalRemote | null;
  // Working-tree git upstream (display + push target), or null for local-only.
  gitRemote: LocalGitRemote | null;
}

// Ensure `<dir>/.cosheaf/.gitignore` exists and ignores everything, so a
// workspace's gitignored sidecar (remote.json's Cosheaf token, any local index
// files) can never be swept into a commit by the Tier-1 `git add -A`. Writing a
// `*` ignore inside the sidecar dir is self-contained — it needs no entry in the
// user's tracked .gitignore and survives even if the dir is created later.
function ensureSidecarIgnored(dir: string): void {
  try {
    const sidecar = join(dir, ".cosheaf");
    mkdirSync(sidecar, { recursive: true });
    const ignore = join(sidecar, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  } catch (_err) {
    // Best-effort: a read-only or odd filesystem shouldn't block opening a
    // folder. remote.json simply won't be auto-protected there.
  }
}

// A profile is valid only with a non-blank name AND email; anything else (blank,
// missing, wrong type) normalizes to null. Shared by setProfile (typed input)
// and readConfig (untrusted JSON), so both gates agree.
function normalizeProfile(name: unknown, email: unknown): WorkbenchProfile | null {
  if (typeof name !== "string" || typeof email !== "string") return null;
  const n = name.trim();
  const e = email.trim();
  return n && e ? { name: n, email: e } : null;
}

function originIdForPath(path: string): string {
  return `local-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

export class WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceEntry>();
  // The Workbench user's git authorship identity, loaded from the config and set
  // on the Profile page. Backends read it lazily as a commit-time fallback.
  private profile: WorkbenchProfile | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly opts: { configPath?: string; user?: string } = {},
  ) {}

  // The fixed local user (see LOCAL_USER); overridable for tests/back-compat.
  get user(): string {
    return this.opts.user ?? LOCAL_USER;
  }

  getProfile(): WorkbenchProfile | null {
    return this.profile;
  }

  // Set (or clear, with null/blank) the git authorship identity and persist it.
  setProfile(profile: WorkbenchProfile | null): void {
    this.profile = normalizeProfile(profile?.name, profile?.email);
    this.persist();
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
  // sidecar remote.json → connected Core config). Does not index or persist.
  buildEntry(dir: string): WorkspaceEntry {
    const path = resolve(dir);
    // Guard the per-workspace sidecar before anything can commit: `.cosheaf/`
    // holds the gitignored remote.json (a live Cosheaf token), and the commit
    // page / Open-PR run `git add -A`. A self-ignoring .gitignore inside the
    // dir keeps that token out of every commit. (In single-folder mode this was
    // a side effect of buildLocalConfig writing the sidecar here; the central
    // data dir moved that out, so the Workbench must write it explicitly.)
    ensureSidecarIgnored(path);
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
      originId: originIdForPath(path),
    };
    const backend = new LocalGitWorkspaceBackend(path, { pushRemote: cfg.gitRemote?.name, author: () => this.getProfile() });
    return { slug, path, identity, backend, remote: cfg.remote, gitRemote: cfg.gitRemote };
  }

  // Index a workspace's markdown + bib files into the shared sidecar, scoped by
  // its slug. Idempotent: re-indexing replaces the workspace's rows.
  async index(entry: WorkspaceEntry): Promise<{ pages: number; bibs: number }> {
    const { owner, repo, defaultMdFormat } = entry.identity;
    const tree = await entry.backend.getTree(owner, repo, "main", true);
    const seenMarkdown = new Set<string>();
    const seenCitations = new Set<string>();
    let pages = 0;
    let bibs = 0;
    for (const node of tree) {
      if (node.type !== "blob") continue;
      if (fileKindForPath(node.path) === "markdown") {
        const content = await entry.backend.getRawFile(owner, repo, "main", node.path);
        indexPage(this.db, { workspaceSlug: entry.slug, filePath: node.path, bodyText: content, formatId: defaultMdFormat });
        seenMarkdown.add(node.path);
        pages++;
      } else if (node.path.toLowerCase().endsWith(".bib")) {
        const content = await entry.backend.getRawFile(owner, repo, "main", node.path);
        indexCitationFile(this.db, { workspaceSlug: entry.slug, filePath: node.path, bodyText: content });
        seenCitations.add(node.path);
        bibs++;
      }
    }
    pruneWorkspaceIndex(this.db, entry.slug, seenMarkdown, seenCitations);
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

  // Re-derive a registered entry from disk (without re-indexing) so a sidecar
  // change — connecting a remote via .cosheaf/remote.json — takes effect:
  // remote / canOpenPull / gitRemote are recomputed. Null if not registered.
  rebuild(slug: string): WorkspaceEntry | null {
    const existing = this.entries.get(slug);
    if (!existing) return null;
    const entry = this.buildEntry(existing.path);
    this.register(entry);
    return entry;
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

  // Read the persisted config: load the profile (a side effect, so a freshly
  // built backend's author getter sees it) and return the workspace paths.
  private readConfig(): string[] {
    const file = this.opts.configPath;
    if (!file || !existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        workspaces?: Array<{ path?: unknown }>;
        profile?: { name?: unknown; email?: unknown };
      };
      this.profile = normalizeProfile(raw.profile?.name, raw.profile?.email);
      return (raw.workspaces ?? []).map((w) => w.path).filter((path): path is string => typeof path === "string");
    } catch (_err) {
      return [];
    }
  }

  private persist(): void {
    const file = this.opts.configPath;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const config: { workspaces: { path: string }[]; profile?: WorkbenchProfile } = {
      workspaces: this.list().map((e) => ({ path: e.path })),
    };
    if (this.profile) config.profile = this.profile;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
}
