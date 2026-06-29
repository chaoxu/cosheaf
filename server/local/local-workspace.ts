// Derive a local Workbench's workspace identity and optional remote from the
// folder on disk. Forge-free: the workspace name is validated against a local
// copy of the forge name shape (the canonical constant's name can't be imported
// here without tripping the no-forge gate).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";

// Same shape the forge enforces for owner/repo names: start with an
// alphanumeric or underscore, then alphanumerics / _ / . / -.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// Fixed owner for a folder with no upstream remote. The Workbench is single-user
// and forge-free, so there is no meaningful account name to qualify the slug —
// `local/<folder>` keeps slugs stable and readable without leaking the OS user.
export const LOCAL_OWNER = "local";

// The remote config lives in the gitignored sidecar — NOT in the git-tracked
// cosheaf.yaml — because it holds a live Cosheaf token that must never be
// committed/pushed by the commit-page or Open-PR `git add -A`.
const REMOTE_FILE = join(".cosheaf", "remote.json");

export interface LocalRemote {
  // Base URL of the remote Cosheaf service (e.g. https://cosheaf.example).
  url: string;
  // Opaque Cosheaf API token (NOT a forge token) used for open-PR / status.
  token: string;
}

// The working tree's git upstream, parsed for display + push. This is the
// transport the user already pushes over (their SSH key); the Workbench shows it
// so a workspace backed by an upstream is visibly distinct from a local-only one.
export interface LocalGitRemote {
  // git remote name (the push target, e.g. "origin" or "cosheaf").
  name: string;
  // host[:port] parsed from the remote URL, for a compact UI label.
  host: string;
  // owner/repo parsed from the remote path — also the slug the Workbench routes
  // under, so the local URL matches the remote's identity.
  owner: string;
  repo: string;
  // The raw remote URL (ssh/https), shown verbatim in the workspace details.
  url: string;
}

export interface LocalWorkspaceConfig {
  owner: string;
  repo: string;
  defaultMdFormat: string;
  // Tier 2 open-PR config from the gitignored sidecar (null → local-only).
  remote: LocalRemote | null;
  // Working-tree git upstream, for display + push remote name (null → no git
  // upstream; Tier 0/1 local-only).
  gitRemote: LocalGitRemote | null;
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9_]+/, "");
  return NAME_RE.test(cleaned) ? cleaned : fallback;
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_err) {
    return null;
  }
}

// Pick the working tree's primary git remote: the one the current branch tracks,
// else `origin`, else the first remote listed. Returns its name + URL, or null
// when the folder is not a git repo or has no remote.
function primaryGitRemote(dir: string): { name: string; url: string } | null {
  const remotes = git(dir, ["remote"]);
  if (remotes === null) return null;
  const names = remotes.split("\n").map((r) => r.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const tracked = branch && branch !== "HEAD" ? git(dir, ["config", `branch.${branch}.remote`]) : null;
  const name = (tracked && names.includes(tracked) && tracked) || (names.includes("origin") && "origin") || names[0];
  const url = git(dir, ["remote", "get-url", name]);
  return url ? { name, url } : null;
}

// Pull host + owner/repo out of a git remote URL: git@host:owner/repo(.git),
// https://host/owner/repo(.git), or ssh://git@host:port/owner/repo(.git).
export function parseGitRemote(remoteUrl: string): { host: string; owner: string; repo: string } | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, "");
  const ownerRepo = cleaned.match(/[:/]([^/:]+)\/([^/]+)$/);
  if (!ownerRepo) return null;
  // host: between the scheme/user and the first ':' or '/' that starts the path.
  const hostMatch = cleaned.match(/^(?:[a-z]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::(\d+))?/i);
  const host = hostMatch ? hostMatch[1] + (hostMatch[2] ? `:${hostMatch[2]}` : "") : "";
  return { host, owner: ownerRepo[1], repo: ownerRepo[2] };
}

// Read the Tier-2 remote from `<dir>/.cosheaf/remote.json` (gitignored). Absent
// or malformed → no remote (Tier 0/1, local-only).
function readRemote(dir: string): LocalRemote | null {
  const path = join(dir, REMOTE_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const { url, token } = raw;
    if (typeof url !== "string" || !url.trim() || typeof token !== "string" || !token.trim()) return null;
    return { url: url.trim(), token: token.trim() };
  } catch (_err) {
    return null;
  }
}

// Resolve the workspace identity from the folder: owner/repo come from the git
// upstream when present (so the local slug matches the remote's, e.g. chao/milk),
// else the fixed `local` owner + the folder name. The Workbench always renders
// Coflat; a Tier-2 open-PR remote is read from the gitignored sidecar.
export function deriveLocalWorkspace(dir: string): LocalWorkspaceConfig {
  const upstream = primaryGitRemote(dir);
  const parsed = upstream ? parseGitRemote(upstream.url) : null;
  const owner = parsed ? sanitizeName(parsed.owner, LOCAL_OWNER) : LOCAL_OWNER;
  const repo = sanitizeName(parsed ? parsed.repo : basename(dir), "workspace");
  const gitRemote: LocalGitRemote | null =
    upstream && parsed ? { name: upstream.name, host: parsed.host, owner, repo, url: upstream.url } : null;
  return {
    owner,
    repo,
    // Coflat renders plain markdown fine; passthrough needs the forge /markdown
    // API which isn't available locally.
    defaultMdFormat: COFLAT_FORMAT_ID,
    remote: readRemote(dir),
    gitRemote,
  };
}
