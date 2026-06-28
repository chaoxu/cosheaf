// Derive a local Workbench's workspace identity and optional remote from the
// folder on disk. Forge-free: the workspace name is validated against a local
// copy of the forge name shape (the canonical constant's name can't be imported
// here without tripping the no-forge gate).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";

// Same shape the forge enforces for owner/repo names: start with an
// alphanumeric or underscore, then alphanumerics / _ / . / -.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

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

export interface LocalWorkspaceConfig {
  owner: string;
  repo: string;
  defaultMdFormat: string;
  remote: LocalRemote | null;
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9_]+/, "");
  return NAME_RE.test(cleaned) ? cleaned : fallback;
}

function gitOrigin(dir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url || null;
  } catch (_err) {
    // Not a git repo, or no `origin` remote — fall back to the folder name.
    return null;
  }
}

// Pull owner/repo out of a git remote URL: git@host:owner/repo(.git),
// https://host/owner/repo(.git), or ssh://git@host:port/owner/repo(.git).
export function ownerRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, "");
  const match = cleaned.match(/[:/]([^/:]+)\/([^/]+)$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
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

// Resolve the workspace identity from the folder: owner/repo from `git remote
// origin` when present (so the local slug matches the remote's), else the OS
// user + folder name. The Workbench always renders Coflat; a remote (Tier 2)
// is read from the gitignored sidecar.
export function deriveLocalWorkspace(dir: string): LocalWorkspaceConfig {
  const origin = gitOrigin(dir);
  const parsed = origin ? ownerRepoFromRemote(origin) : null;
  const fallbackOwner = sanitizeName(userInfo().username || "local", "local");
  const owner = parsed ? sanitizeName(parsed.owner, fallbackOwner) : fallbackOwner;
  const repo = sanitizeName(parsed ? parsed.repo : basename(dir), "workspace");
  return {
    owner,
    repo,
    // Coflat renders plain markdown fine; passthrough needs the forge /markdown
    // API which isn't available locally.
    defaultMdFormat: COFLAT_FORMAT_ID,
    remote: readRemote(dir),
  };
}
