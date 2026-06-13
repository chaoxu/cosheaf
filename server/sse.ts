// Tiny SSE pub/sub keyed by workspace slug — the Forgejo `owner/repo` full
// name. Webhooks publish; SSE handlers subscribe. Event payloads carry no
// repo identity; the channel key is the only identity.

export interface SSEEvent {
  type: string;
  [k: string]: unknown;
}

type Handler = (e: SSEEvent) => void;

export class SSEHub {
  private subs = new Map<string, Set<Handler>>();

  subscribe(slug: string, h: Handler): () => void {
    let set = this.subs.get(slug);
    if (!set) {
      set = new Set();
      this.subs.set(slug, set);
    }
    set.add(h);
    return () => {
      set?.delete(h);
      if (set && set.size === 0) this.subs.delete(slug);
    };
  }

  publish(slug: string, e: SSEEvent): void {
    const set = this.subs.get(slug);
    if (!set) return;
    for (const h of set) {
      try {
        h(e);
      } catch (_err) {
        // swallow — one bad subscriber should not affect the rest
      }
    }
  }
}
