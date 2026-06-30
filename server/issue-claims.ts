import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { IssueClaim } from "../shared/issues.js";

// Optional live-work leases (#95): ephemeral, local advisory coordination state
// with no Forgejo or Origin API authority. A claim is an exclusive lease only
// inside this Cosheaf server process and workspace sidecar: a second runner gets
// a 409 carrying the active claim so it can avoid duplicate work. Leases expire
// and are disposable; nothing here is durable knowledge or collaboration state.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
// Bound the lease so a crashed runner can never hold an issue forever.
const MAX_TTL_MS = 60 * 60 * 1000;

interface ClaimRow {
  id: string;
  workspace_slug: string;
  issue_number: number;
  runner_name: string;
  purpose: string;
  holder_username: string;
  created_at: number;
  heartbeat_at: number;
  expires_at: number;
}

function toClaim(row: ClaimRow): IssueClaim {
  return {
    id: row.id,
    issue_number: row.issue_number,
    runner_name: row.runner_name,
    purpose: row.purpose,
    holder_username: row.holder_username,
    created_at: row.created_at,
    heartbeat_at: row.heartbeat_at,
    expires_at: row.expires_at,
  };
}

// Resolve the lease duration from a request body: `ttl_seconds` wins, else an
// absolute `expires_at` (ms), else the default — always clamped to MAX_TTL_MS.
export function claimTtlMs(body: { ttl_seconds?: unknown; expires_at?: unknown }, now: number): number {
  if (typeof body.ttl_seconds === "number" && Number.isFinite(body.ttl_seconds) && body.ttl_seconds > 0) {
    return Math.min(body.ttl_seconds * 1000, MAX_TTL_MS);
  }
  if (typeof body.expires_at === "number" && Number.isFinite(body.expires_at) && body.expires_at > now) {
    return Math.min(body.expires_at - now, MAX_TTL_MS);
  }
  return DEFAULT_TTL_MS;
}

function purgeExpired(db: Database.Database, now: number): void {
  db.prepare("DELETE FROM issue_claims WHERE expires_at <= ?").run(now);
}

export function activeClaims(db: Database.Database, slug: string, issueNumber: number, now: number): IssueClaim[] {
  return (
    db
      .prepare("SELECT * FROM issue_claims WHERE workspace_slug = ? AND issue_number = ? AND expires_at > ? ORDER BY created_at")
      .all(slug, issueNumber, now) as ClaimRow[]
  ).map(toClaim);
}

// Active claims for a batch of issue numbers, grouped by number — one query for
// the whole issue list.
export function activeClaimsByIssue(
  db: Database.Database,
  slug: string,
  numbers: readonly number[],
  now: number,
): Map<number, IssueClaim[]> {
  const map = new Map<number, IssueClaim[]>();
  if (numbers.length === 0) return map;
  const placeholders = numbers.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM issue_claims WHERE workspace_slug = ? AND expires_at > ? AND issue_number IN (${placeholders})`)
    .all(slug, now, ...numbers) as ClaimRow[];
  for (const row of rows) {
    const list = map.get(row.issue_number) ?? [];
    list.push(toClaim(row));
    map.set(row.issue_number, list);
  }
  return map;
}

export type ClaimResult = { ok: true; claim: IssueClaim } | { ok: false; conflict: IssueClaim };

export function claimIssue(
  db: Database.Database,
  args: { slug: string; issueNumber: number; runnerName: string; purpose: string; holder: string; ttlMs: number; now: number },
): ClaimResult {
  const { slug, issueNumber, runnerName, purpose, holder, ttlMs, now } = args;
  purgeExpired(db, now);
  const active = activeClaims(db, slug, issueNumber, now);
  const mine = active.find((c) => c.runner_name === runnerName);
  const other = active.find((c) => c.runner_name !== runnerName);
  if (other && !mine) return { ok: false, conflict: other };
  const expires = now + ttlMs;
  if (mine) {
    // Re-claiming by the same runner refreshes the lease in place (idempotent).
    db.prepare("UPDATE issue_claims SET purpose = ?, holder_username = ?, heartbeat_at = ?, expires_at = ? WHERE id = ?").run(
      purpose,
      holder,
      now,
      expires,
      mine.id,
    );
    return { ok: true, claim: { ...mine, purpose, holder_username: holder, heartbeat_at: now, expires_at: expires } };
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO issue_claims (id, workspace_slug, issue_number, runner_name, purpose, holder_username, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, slug, issueNumber, runnerName, purpose, holder, now, now, expires);
  return {
    ok: true,
    claim: { id, issue_number: issueNumber, runner_name: runnerName, purpose, holder_username: holder, created_at: now, heartbeat_at: now, expires_at: expires },
  };
}

export function heartbeatClaim(
  db: Database.Database,
  args: { slug: string; issueNumber: number; id: string; ttlMs: number; now: number },
): IssueClaim | null {
  const { slug, issueNumber, id, ttlMs, now } = args;
  const row = db
    .prepare("SELECT * FROM issue_claims WHERE id = ? AND workspace_slug = ? AND issue_number = ? AND expires_at > ?")
    .get(id, slug, issueNumber, now) as ClaimRow | undefined;
  if (!row) return null;
  const expires = now + ttlMs;
  db.prepare("UPDATE issue_claims SET heartbeat_at = ?, expires_at = ? WHERE id = ?").run(now, expires, id);
  return { ...toClaim(row), heartbeat_at: now, expires_at: expires };
}

export function releaseClaim(db: Database.Database, args: { slug: string; issueNumber: number; id: string }): boolean {
  const info = db
    .prepare("DELETE FROM issue_claims WHERE id = ? AND workspace_slug = ? AND issue_number = ?")
    .run(args.id, args.slug, args.issueNumber);
  return info.changes > 0;
}
