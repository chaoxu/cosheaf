import { buildReferenceCatalog } from "@chaoxu/coflat/parse";

export type CoflatXrefTargetKind = "block" | "equation" | "heading";

export interface CoflatXrefTarget {
  id: string;
  kind: CoflatXrefTargetKind;
  label: string;
  line: number;
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
