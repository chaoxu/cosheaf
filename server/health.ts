import type Database from "better-sqlite3";
import { pdfExportMetrics, type PdfExportMetrics } from "./pdf-export.js";

export interface HealthPayload {
  ok: boolean;
  commit: string;
  coflat_ref: string;
  checks: {
    sqlite: "ok" | "fail";
  };
  pdf_export: PdfExportMetrics;
  error?: string;
}

export function healthPayload(
  db: Database.Database,
  commit = process.env.COSHEAF_GIT_SHA ?? "unknown",
  coflatRef = process.env.COFLAT_GIT_REF ?? "unknown",
): HealthPayload {
  const pdf_export = pdfExportMetrics();
  try {
    db.prepare("SELECT 1 FROM doc_map LIMIT 1").get();
    return { ok: true, commit, coflat_ref: coflatRef, checks: { sqlite: "ok" }, pdf_export };
  } catch (err) {
    return {
      ok: false,
      commit,
      coflat_ref: coflatRef,
      checks: { sqlite: "fail" },
      pdf_export,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function healthStatus(payload: HealthPayload): 200 | 503 {
  return payload.ok ? 200 : 503;
}
