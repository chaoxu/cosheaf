import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../types.js";
import type { SSEHub } from "../sse.js";

// Stream one SSEHub channel to the client as Server-Sent Events: subscribe,
// emit a `ready` event, then keep the connection warm with a 30s `ping` until
// the client disconnects. Shared by the per-workspace events route and the
// per-user notification events route — the only thing that varies is the
// channel key.
export function streamHubChannel(c: Context<AppEnv>, hub: SSEHub, channel: string): Response {
  return streamSSE(c, async (stream) => {
    const unsub = hub.subscribe(channel, (e) => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    });
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: "ready" }), event: "ready" });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(30000);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ data: "{}", event: "ping" });
      }
    } finally {
      unsub();
    }
  });
}
