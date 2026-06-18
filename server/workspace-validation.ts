import type Database from "better-sqlite3";
import type { WorkspaceValidation } from "../shared/validation.js";
import { getDocumentFormat } from "./format-registry.js";

export function workspaceSupportsXrefs(formatId: string | null | undefined): boolean {
  return Boolean(getDocumentFormat(formatId).extractXrefTargets);
}

export function workspaceValidation(
  db: Database.Database,
  workspaceSlug: string,
  formatId: string | null | undefined,
): WorkspaceValidation {
  const supportsXrefs = workspaceSupportsXrefs(formatId);
  const brokenRefs = db
    .prepare(
      `SELECT b.src_id AS source_id,
              b.src_path AS source_path,
              src.title AS source_title,
              b.target_id AS target_id,
              b.target_label AS target_label,
              b.line AS line
         FROM backlinks b
         LEFT JOIN doc_map src
           ON src.workspace_slug = b.workspace_slug
          AND src.cosheaf_id = b.src_id
        WHERE b.workspace_slug = ?
          AND (
            b.target_id IS NULL
            OR (
              NOT EXISTS (
                SELECT 1 FROM doc_map target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.cosheaf_id = b.target_id
              )
              ${supportsXrefs ? `AND NOT EXISTS (
                SELECT 1 FROM xref_targets target
                 WHERE target.workspace_slug = b.workspace_slug
                   AND target.target_id = b.target_id
              )` : ""}
            )
          )
        ORDER BY b.src_path, b.line, b.target_label`,
    )
    .all(workspaceSlug) as WorkspaceValidation["broken_refs"];
  const orphanLabels = db
    .prepare(
      `SELECT d.cosheaf_id AS id,
              d.forgejo_id AS path,
              d.title AS title
         FROM doc_map d
         LEFT JOIN backlinks b
           ON b.workspace_slug = d.workspace_slug
          AND b.target_id = d.cosheaf_id
          AND b.src_id != d.cosheaf_id
        WHERE d.workspace_slug = ?
          AND b.src_id IS NULL
        ORDER BY d.forgejo_id`,
    )
    .all(workspaceSlug) as WorkspaceValidation["orphan_labels"];
  const duplicateXrefs = supportsXrefs
    ? db
        .prepare(
          `SELECT id, group_concat(path_note, ', ') AS paths, sum(count) AS count
             FROM (
               SELECT target_id AS id, source_path AS path_note, 1 AS count
                 FROM xref_targets
                WHERE workspace_slug = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM xref_target_duplicates duplicate
                     WHERE duplicate.workspace_slug = xref_targets.workspace_slug
                       AND duplicate.target_id = xref_targets.target_id
                       AND duplicate.source_path = xref_targets.source_path
                  )
               UNION ALL
               SELECT target_id AS id, source_path || ' (' || count || ' definitions)' AS path_note, count
                 FROM xref_target_duplicates
                WHERE workspace_slug = ?
             )
            GROUP BY id
           HAVING sum(count) > 1
            ORDER BY id`,
        )
        .all(workspaceSlug, workspaceSlug) as WorkspaceValidation["duplicate_xrefs"]
    : [];
  return { broken_refs: brokenRefs, duplicate_xrefs: duplicateXrefs, orphan_labels: orphanLabels };
}
