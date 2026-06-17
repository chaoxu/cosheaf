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

export function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < end; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
