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
    if (process.env.COSHEAF_REQUEST_LOG) {
      console.log(`sse publish slug=${slug} type=${e.type} subscribers=${set?.size ?? 0}`);
    }
    if (!set) return;
    for (const h of set) {
      try {
        h(e);
      } catch (err) {
        // One bad subscriber must not block the rest — but a silently swallowed
        // handler error is invisible, so log it (don't rethrow).
        console.error(`sse subscriber failed (slug=${slug} type=${e.type}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
