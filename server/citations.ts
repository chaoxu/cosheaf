import { parseBibTeX } from "@chaoxu/coflat/citeproc";

export function extractBibTeXCitationKeys(source: string): string[] {
  try {
    const keys = new Set<string>();
    for (const item of parseBibTeX(source)) if (item.id) keys.add(item.id);
    return [...keys];
  } catch (_error) {
    return [];
  }
}
