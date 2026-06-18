import type Database from "better-sqlite3";
import { parse } from "yaml";
import { ForgejoError, type Forgejo } from "./forgejo.js";

// Git-managed, repo-level Cosheaf config (#182). Authoritative on the branch as
// `cosheaf.yaml`; SQLite only caches the parsed result (derived/rebuildable,
// like doc_map). The webhook busts the cache on a cosheaf.yaml push and
// `workspace reindex` clears it; the next render reloads from Forgejo. First and
// main consumer was repo-wide math macros (#183); paper defaults and asset
// placement now share the same branch-scoped config surface.
export const REPO_CONFIG_PATH = "cosheaf.yaml";

export interface RepoConfig {
  // KaTeX macro map from the file's `math:` key (e.g. { "\\R": "\\mathbb{R}" }).
  mathMacros: Record<string, string>;
  // Repository-relative folder for pasted/uploaded assets.
  assetFolder: string;
  // Paper/export defaults. Document frontmatter or explicit export query params
  // still win when present.
  bibliography?: string;
  csl?: string;
  pdfBibliography?: string;
  pdfCsl?: string;
  pdfTemplate?: string;
  // Parsed for visibility/future handoff; Coflat currently reads block config
  // from document frontmatter, so Cosheaf does not inject these into the editor.
  blockDefinitions: Record<string, unknown>;
}

const DEFAULT_ASSET_FOLDER = "assets";
const EMPTY: RepoConfig = { mathMacros: {}, assetFolder: DEFAULT_ASSET_FOLDER, blockDefinitions: {} };

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assetFolderFrom(raw: Record<string, unknown>): string {
  const assets = raw.assets;
  const folder = typeof assets === "string"
    ? assets
    : stringValue(recordValue(assets)?.folder ?? recordValue(assets)?.imageFolder ?? recordValue(assets)?.["image-folder"]);
  const value = folder ?? stringValue(raw.imageFolder ?? raw["image-folder"]) ?? DEFAULT_ASSET_FOLDER;
  return safeConfigFolder(value) ?? DEFAULT_ASSET_FOLDER;
}

function safeConfigFolder(value: string): string | null {
  const clean = value.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.startsWith(".") || clean.includes("\\") || clean.includes("//")) return null;
  if (clean.split("/").some((part) => part === "." || part === ".." || part === "")) return null;
  if (/%2e%2e|%2f|%5c/i.test(clean)) return null;
  return clean;
}

// Parse the known keys out of a cosheaf.yaml document. Unknown keys are ignored
// (room to grow without speculative schema); a missing/empty/invalid file or a
// non-object root yields the empty config.
export function parseRepoConfig(yamlText: string): RepoConfig {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch (_error) {
    return EMPTY;
  }
  const raw = recordValue(doc);
  if (!raw) return EMPTY;
  const latex = recordValue(raw.latex);
  const pdf = recordValue(raw.pdf);
  const bibliography = stringValue(raw.bibliography);
  const csl = stringValue(raw.csl);
  const pdfBibliography = stringValue(pdf?.bibliography) ?? stringValue(latex?.bibliography) ?? bibliography;
  const pdfCsl = stringValue(pdf?.csl) ?? stringValue(latex?.csl) ?? csl;
  const pdfTemplate = stringValue(pdf?.template) ?? stringValue(latex?.template) ?? stringValue(raw.template);
  return {
    mathMacros: stringMap(raw.math),
    assetFolder: assetFolderFrom(raw),
    ...(bibliography ? { bibliography } : {}),
    ...(csl ? { csl } : {}),
    ...(pdfBibliography ? { pdfBibliography } : {}),
    ...(pdfCsl ? { pdfCsl } : {}),
    ...(pdfTemplate ? { pdfTemplate } : {}),
    blockDefinitions: recordValue(raw.blocks) ?? {},
  };
}

// Coalesce concurrent cold-cache loads for the same (slug, branch): a thread
// with N comments renders N coflat surfaces in one Promise.all, all of which
// miss the cache synchronously before the first fetch resolves — without this
// they'd each fire a redundant cosheaf.yaml round-trip (the herd is the same
// for repos with no file, which 404 N times). Keyed promises collapse them into
// one fetch + one upsert; the entry is cleared when it settles.
const inFlight = new Map<string, Promise<RepoConfig>>();

// Resolve the repo config for a branch, caching the parsed result in the
// sidecar. Cache hit → one SQLite read. Miss → fetch cosheaf.yaml from Forgejo,
// parse, cache (a missing file caches the empty config so repos without one
// don't refetch every render). A transient (non-404) fetch failure degrades to
// empty for this render without caching, so it self-heals next time.
export async function loadRepoConfig(
  db: Database.Database,
  fj: Forgejo,
  owner: string,
  repo: string,
  branch: string,
): Promise<RepoConfig> {
  const slug = `${owner}/${repo}`;
  const cached = db
    .prepare("SELECT config_json FROM repo_config WHERE workspace_slug = ? AND branch = ?")
    .get(slug, branch) as { config_json: string } | undefined;
  if (cached) return JSON.parse(cached.config_json) as RepoConfig;

  const key = `${slug}\n${branch}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const load = (async (): Promise<RepoConfig> => {
    let config = EMPTY;
    try {
      config = parseRepoConfig(await fj.getRawFile(owner, repo, branch, REPO_CONFIG_PATH));
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 404)) return EMPTY;
    }
    db.prepare(
      `INSERT INTO repo_config (workspace_slug, branch, config_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_slug, branch) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
    ).run(slug, branch, JSON.stringify(config), Date.now());
    return config;
  })();
  inFlight.set(key, load);
  try {
    return await load;
  } finally {
    inFlight.delete(key);
  }
}

// Drop the cached config for one branch (webhook on a cosheaf.yaml push).
export function bustRepoConfig(db: Database.Database, slug: string, branch: string): void {
  db.prepare("DELETE FROM repo_config WHERE workspace_slug = ? AND branch = ?").run(slug, branch);
}

// Drop all cached config for a workspace (reindex rebuilds lazily on next read).
export function clearRepoConfig(db: Database.Database, slug: string): void {
  db.prepare("DELETE FROM repo_config WHERE workspace_slug = ?").run(slug);
}
