// Pure mapping from cosheaf `/suggest` results to CodeMirror completions for
// the reference (`[@`) popup. This is the coflat-independent half of #387: the
// live wiring (coflat's `findReferenceCompletionMatch` + `extraCompletionSourcesFacet`)
// lives in reference-suggest-source.ts; keeping the mapping/dedup here makes it
// unit-testable without a mounted editor.

import type { Completion, CompletionResult } from "@codemirror/autocomplete";

export interface ReferenceSuggestion {
  readonly id: string;
  readonly insert: string;
  readonly display: string;
}

// Keep the popup open while the user types characters that are still part of a
// reference id — mirrors Coflat's REF_QUERY_RE so cosheaf's options stay live
// alongside the native ones instead of being dropped on the next keystroke.
export const REFERENCE_QUERY_RE = /^[\w:./'-]*$/;

// Drop a leading "id — " from the display so the completion detail doesn't
// repeat the label; page rows use the bare title, xref rows prefix the id.
function referenceDetail(suggestion: ReferenceSuggestion): string | undefined {
  const { id, display } = suggestion;
  if (!display || display === id) return undefined;
  const prefix = `${id} — `;
  const detail = display.startsWith(prefix) ? display.slice(prefix.length) : display;
  return detail || undefined;
}

export function referenceSuggestionToCompletion(suggestion: ReferenceSuggestion): Completion {
  return {
    label: suggestion.id,
    apply: suggestion.insert,
    type: "reference",
    ...(referenceDetail(suggestion) ? { detail: referenceDetail(suggestion) } : {}),
  };
}

// Build the CM6 result at the native popup's [from,to] range so CodeMirror
// merges cosheaf's cross-file options into the single reference popup rather
// than opening a second one. Deduplicates by id (the server already merges
// page + xref rows, but a page and its own xref target can collide).
export function buildReferenceCompletionResult(
  from: number,
  to: number,
  suggestions: readonly ReferenceSuggestion[],
): CompletionResult | null {
  const seen = new Set<string>();
  const options: Completion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.id || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    options.push(referenceSuggestionToCompletion(suggestion));
  }
  if (options.length === 0) return null;
  return { from, to, options, validFor: REFERENCE_QUERY_RE };
}
