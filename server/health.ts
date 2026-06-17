import type Database from "better-sqlite3";

export interface HealthPayload {
  ok: boolean;
  commit: string;
  checks: {
    sqlite: "ok" | "fail";
  };
  error?: string;
}

export function healthPayload(db: Database.Database, commit = process.env.COSHEAF_GIT_SHA ?? "unknown"): HealthPayload {
  try {
    db.prepare("SELECT 1 FROM doc_map LIMIT 1").get();
    return { ok: true, commit, checks: { sqlite: "ok" } };
  } catch (err) {
    return {
      ok: false,
      commit,
      checks: { sqlite: "fail" },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function healthStatus(payload: HealthPayload): 200 | 503 {
  return payload.ok ? 200 : 503;
}
