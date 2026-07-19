import { buildReferenceCatalog, extractReferences } from "@chaoxu/coflat/parse";

export type CoflatXrefTargetKind = "block" | "equation" | "heading";

export interface CoflatXrefTarget {
  id: string;
  kind: CoflatXrefTargetKind;
  label: string;
  line: number;
}

// The distinct `[@id]` cross-reference keys a document refers to. Shared by the
// reader island (to decide what to resolve) and the server (to pre-resolve and
// embed those refs in the reader payload), so both agree on exactly which keys
// count as crossrefs.
export function referencedCrossrefKeys(source: string): string[] {
  return [
    ...new Set(
      extractReferences(source)
        .filter((ref) => ref.kind === "crossref" && ref.key)
        .map((ref) => ref.key as string),
    ),
  ];
}

export function extractCoflatXrefTargets(source: string): CoflatXrefTarget[] {
  return buildReferenceCatalog(source).targets
    .filter((target): target is typeof target & { id: string } => Boolean(target.id))
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      label: target.displayLabel,
      line: target.line,
    }));
}
