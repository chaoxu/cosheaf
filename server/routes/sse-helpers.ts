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
    // Resolve the instant the client disconnects so the keep-alive loop stops and
    // unsub() runs immediately. Without it, the handler sleeps up to 30s after a
    // disconnect — leaking the hub subscription and a CLOSE_WAIT socket per
    // navigation/tab. That matters under churn, and especially on HTTP/1.1 where
    // every lingering connection counts against the browser's ~6-per-origin cap.
    const disconnected = new Promise<void>((resolve) => stream.onAbort(resolve));
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: "ready" }), event: "ready" });
      while (!stream.aborted && !stream.closed) {
        await Promise.race([stream.sleep(30000), disconnected]);
        if (stream.aborted || stream.closed) break;
        await stream.writeSSE({ data: "{}", event: "ping" });
      }
    } finally {
      unsub();
    }
  });
}
