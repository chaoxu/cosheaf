// Derive a local Workbench's workspace identity, document format, and optional
// remote from the folder on disk. Forge-free: the workspace name is validated
// against a local copy of the forge name shape (the canonical constant's name
// can't be imported here without tripping the no-forge gate).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";

// Same shape the forge enforces for owner/repo names: start with an
// alphanumeric or underscore, then alphanumerics / _ / . / -.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// Repo-level config file (mirrors REPO_CONFIG_PATH in repo-config.ts; not
// imported to keep this module decoupled from the route layer).
const CONFIG_FILE = "cosheaf.yaml";

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

function readConfigDoc(dir: string): Record<string, unknown> | null {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    const doc = parseYaml(readFileSync(path, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch (_err) {
    // A malformed config file should not block opening the folder.
    return null;
  }
}

function formatFromDoc(_doc: Record<string, unknown> | null): string {
  // The Workbench renders Coflat directly; the passthrough format depends on the
  // forge's /markdown API, which isn't available locally. So a local workspace is
  // always Coflat regardless of cosheaf.yaml — Coflat renders plain markdown fine.
  return COFLAT_FORMAT_ID;
}

function remoteFromDoc(doc: Record<string, unknown> | null): LocalRemote | null {
  const raw = doc?.remote;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { url, token } = raw as Record<string, unknown>;
  if (typeof url !== "string" || !url.trim() || typeof token !== "string" || !token.trim()) return null;
  return { url: url.trim(), token: token.trim() };
}

// Resolve the workspace identity from the folder: owner/repo from `git remote
// origin` when present (so the local slug matches the remote's), else the OS
// user + folder name. Format + optional remote come from cosheaf.yaml.
export function deriveLocalWorkspace(dir: string): LocalWorkspaceConfig {
  const doc = readConfigDoc(dir);
  const origin = gitOrigin(dir);
  const parsed = origin ? ownerRepoFromRemote(origin) : null;
  const fallbackOwner = sanitizeName(userInfo().username || "local", "local");
  const owner = parsed ? sanitizeName(parsed.owner, fallbackOwner) : fallbackOwner;
  const repo = sanitizeName(parsed ? parsed.repo : basename(dir), "workspace");
  return {
    owner,
    repo,
    defaultMdFormat: formatFromDoc(doc),
    remote: remoteFromDoc(doc),
  };
}
