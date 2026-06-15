// Tiny in-process TTL cache. Three sites used to roll this inline
// (bearer→username, ${owner}/${repo}/${user}→role, tree-cache); they all
// shared the {value, expiresAt} pattern with manual Date.now() checks.
// MAX_ENTRIES is optional and only the tree cache needs it.

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TTLCache<K, V> {
  private map = new Map<K, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number | null;

  constructor(ttlMs: number, opts: { maxEntries?: number } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = opts.maxEntries ?? null;
  }

  get(key: K): V | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  // Return the cached value or run the fetcher once and store it. A miss/expiry
  // runs the fetcher; a fetcher throw propagates and is NOT cached. Centralizes
  // the null-means-miss get/fetch/set dance the repo-keyed resolvers shared.
  async getOrFetch(key: K, fetcher: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const value = await fetcher();
    this.set(key, value);
    return value;
  }

  set(key: K, value: V, ttlMsOverride?: number): void {
    if (this.maxEntries !== null && this.map.size >= this.maxEntries && !this.map.has(key)) {
      // Map preserves insertion order; drop oldest.
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMsOverride ?? this.ttlMs) });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
