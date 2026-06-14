import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { activeClaims, activeClaimsByIssue, claimIssue, claimTtlMs, heartbeatClaim, releaseClaim } from "./issue-claims.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-claims-"));
  const db = new Database(path.join(dir, "test.sqlite"));
  db.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  return db;
}

const SLUG = "chao/flushing-coin";

describe("issue-claims", () => {
  it("creates a claim and exposes it as active", () => {
    const db = freshDb();
    const now = 1_000_000;
    const r = claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-a", purpose: "prove", holder: "chao", ttlMs: 60_000, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.claim.runner_name).toBe("bot-a");
    expect(r.claim.expires_at).toBe(now + 60_000);
    expect(activeClaims(db, SLUG, 5, now).map((c) => c.id)).toEqual([r.claim.id]);
  });

  it("rejects a second runner with the active claim", () => {
    const db = freshDb();
    const now = 1_000_000;
    claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-a", purpose: "", holder: "chao", ttlMs: 60_000, now });
    const r = claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-b", purpose: "", holder: "chao", ttlMs: 60_000, now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflict.runner_name).toBe("bot-a");
  });

  it("re-claim by the same runner refreshes the lease in place (idempotent)", () => {
    const db = freshDb();
    const first = claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-a", purpose: "", holder: "chao", ttlMs: 60_000, now: 1_000_000 });
    const second = claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-a", purpose: "p2", holder: "chao", ttlMs: 60_000, now: 1_030_000 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.claim.id).toBe(first.claim.id);
    expect(second.claim.purpose).toBe("p2");
    expect(activeClaims(db, SLUG, 5, 1_030_000)).toHaveLength(1);
  });

  it("lets a different runner claim once the first lease expires", () => {
    const db = freshDb();
    claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-a", purpose: "", holder: "chao", ttlMs: 10_000, now: 1_000_000 });
    const later = 1_000_000 + 20_000;
    expect(activeClaims(db, SLUG, 5, later)).toHaveLength(0);
    const r = claimIssue(db, { slug: SLUG, issueNumber: 5, runnerName: "bot-b", purpose: "", holder: "chao", ttlMs: 10_000, now: later });
    expect(r.ok).toBe(true);
  });

  it("heartbeat extends expiry; release removes the claim", () => {
    const db = freshDb();
    const created = claimIssue(db, { slug: SLUG, issueNumber: 7, runnerName: "bot-a", purpose: "", holder: "chao", ttlMs: 30_000, now: 1_000_000 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const beat = heartbeatClaim(db, { slug: SLUG, issueNumber: 7, id: created.claim.id, ttlMs: 60_000, now: 1_010_000 });
    expect(beat?.expires_at).toBe(1_010_000 + 60_000);
    expect(releaseClaim(db, { slug: SLUG, issueNumber: 7, id: created.claim.id })).toBe(true);
    expect(activeClaims(db, SLUG, 7, 1_010_000)).toHaveLength(0);
    // heartbeat on a missing/expired claim returns null
    expect(heartbeatClaim(db, { slug: SLUG, issueNumber: 7, id: created.claim.id, ttlMs: 1000, now: 1_020_000 })).toBeNull();
  });

  it("batches active claims by issue number", () => {
    const db = freshDb();
    const now = 1_000_000;
    claimIssue(db, { slug: SLUG, issueNumber: 1, runnerName: "a", purpose: "", holder: "chao", ttlMs: 60_000, now });
    claimIssue(db, { slug: SLUG, issueNumber: 3, runnerName: "b", purpose: "", holder: "chao", ttlMs: 60_000, now });
    const map = activeClaimsByIssue(db, SLUG, [1, 2, 3], now);
    expect(map.get(1)).toHaveLength(1);
    expect(map.has(2)).toBe(false);
    expect(map.get(3)?.[0].runner_name).toBe("b");
  });

  it("resolves ttl from ttl_seconds, expires_at, or default, clamped to 1h", () => {
    const now = 1_000_000;
    expect(claimTtlMs({ ttl_seconds: 120 }, now)).toBe(120_000);
    expect(claimTtlMs({ expires_at: now + 45_000 }, now)).toBe(45_000);
    expect(claimTtlMs({}, now)).toBe(5 * 60 * 1000);
    expect(claimTtlMs({ ttl_seconds: 99_999 }, now)).toBe(60 * 60 * 1000);
    expect(claimTtlMs({ expires_at: now - 100 }, now)).toBe(5 * 60 * 1000); // past expiry → default
  });
});
