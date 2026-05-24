// In-process tree cache. Forgejo's getTree paginates up to ~20 calls for a
// large repo and branch/file pages re-fetch on navigation; without a cache,
// branch switches feel sluggish even on a warm server. Webhooks invalidate
// per-repo on push so cached entries can't outlast their source.

import type { ForgejoTreeEntry } from "./forgejo-types.js";
import { TTLCache } from "./ttl-cache.js";

// Soft cap to prevent runaway growth from a script hammering different refs.
const MAX_ENTRIES = 256;
const TTL_MS = 5 * 60_000;
const cache = new TTLCache<string, ForgejoTreeEntry[]>(TTL_MS, { maxEntries: MAX_ENTRIES });

function key(owner: string, repo: string, ref: string): string {
  return `${owner}|${repo}|${ref}`;
}

export function getCachedTree(owner: string, repo: string, ref: string): ForgejoTreeEntry[] | undefined {
  return cache.get(key(owner, repo, ref)) ?? undefined;
}

export function setCachedTree(owner: string, repo: string, ref: string, tree: ForgejoTreeEntry[]): void {
  cache.set(key(owner, repo, ref), tree);
}

export function invalidateBranchTree(owner: string, repo: string, ref: string): void {
  cache.delete(key(owner, repo, ref));
}

// Drop every cached ref for a repo. Called from the push webhook handler —
// `push` may move main or any user branch, and the per-ref cost of looking
// up which refs changed is higher than just repopulating on next read.
export function invalidateRepoTrees(owner: string, repo: string): void {
  const prefix = `${owner}|${repo}|`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function _clearTreeCacheForTests(): void {
  cache.clear();
}
