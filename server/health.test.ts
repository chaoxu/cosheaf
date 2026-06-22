import { describe, expect, it } from "vitest";
import { healthPayload, healthStatus } from "./health.js";
import { freshTestDb } from "./routes/test-fixtures.js";

describe("healthPayload", () => {
  it("reports ok when the SQLite sidecar schema is queryable", () => {
    const db = freshTestDb("cosheaf-health-");

    expect(healthPayload(db, "abc123", "coflat123")).toEqual({
      ok: true,
      commit: "abc123",
      coflat_ref: "coflat123",
      checks: { sqlite: "ok" },
      pdf_export: { active: 0, queued: 0, concurrency: 1, queue_limit: 4 },
    });
  });

  it("reports failure when the SQLite sidecar check throws", () => {
    const db = {
      prepare: () => {
        throw new Error("database is locked");
      },
    };

    expect(healthPayload(db as never, "abc123", "coflat123")).toEqual({
      ok: false,
      commit: "abc123",
      coflat_ref: "coflat123",
      checks: { sqlite: "fail" },
      pdf_export: { active: 0, queued: 0, concurrency: 1, queue_limit: 4 },
      error: "database is locked",
    });
  });
});

describe("healthStatus", () => {
  it("returns the HTTP status consumed by container healthchecks", () => {
    const pdf_export = { active: 0, queued: 0, concurrency: 1, queue_limit: 4 };
    expect(healthStatus({ ok: true, commit: "abc123", coflat_ref: "coflat123", checks: { sqlite: "ok" }, pdf_export })).toBe(200);
    expect(healthStatus({ ok: false, commit: "abc123", coflat_ref: "coflat123", checks: { sqlite: "fail" }, pdf_export })).toBe(503);
  });
});
