import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const staleAfterMs = 10 * 60 * 1000;
const heartbeatMs = 60 * 1000;
const retryDelayMs = 50;
const heldWorkspaces = new AsyncLocalStorage<ReadonlySet<string>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withWorkspaceSidecarLock<T>(
  db: Database.Database,
  slug: string,
  work: () => Promise<T>,
): Promise<T> {
  const held = heldWorkspaces.getStore();
  if (held?.has(slug)) return work();

  const holder = `${process.pid}:${randomUUID()}`;
  const cleanupStale = db.prepare("DELETE FROM workspace_locks WHERE workspace_slug = ? AND acquired_at < ?");
  const acquire = db.prepare(
    "INSERT OR IGNORE INTO workspace_locks (workspace_slug, holder, acquired_at) VALUES (?, ?, ?)",
  );
  const heartbeat = db.prepare("UPDATE workspace_locks SET acquired_at = ? WHERE workspace_slug = ? AND holder = ?");
  const release = db.prepare("DELETE FROM workspace_locks WHERE workspace_slug = ? AND holder = ?");

  for (;;) {
    const now = Date.now();
    cleanupStale.run(slug, now - staleAfterMs);
    const info = acquire.run(slug, holder, now);
    if (info.changes === 1) break;
    await sleep(retryDelayMs);
  }

  const heartbeatTimer = setInterval(() => {
    heartbeat.run(Date.now(), slug, holder);
  }, heartbeatMs);
  heartbeatTimer.unref();

  try {
    return await heldWorkspaces.run(new Set([...(held ?? []), slug]), work);
  } finally {
    clearInterval(heartbeatTimer);
    release.run(slug, holder);
  }
}
