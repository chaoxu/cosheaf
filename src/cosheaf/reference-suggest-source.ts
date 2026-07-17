// #387: feed cosheaf's cross-file `/suggest` results into Coflat's single
// native reference (`[@`) popup. Coflat owns the trigger detection and the one
// `autocompletion` instance; hosts contribute extra candidates through
// `extraCompletionSourcesFacet`, so registering here merges cross-file page
// ids + xref targets into the same popup rather than opening a competing one
// (the duplicate that be6791f5 removed).

import { extraCompletionSourcesFacet, findReferenceCompletionMatch } from "@chaoxu/coflat";
import type { CompletionSource } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { api } from "./api";
import { buildReferenceCompletionResult } from "./reference-suggest-completions";

export interface ReferenceSuggestContext {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  // Repo-relative path of the document being edited, so the server can drop
  // this file's own labels (Coflat's native source already provides them). #390
  readonly path: string;
}

// The context is read live (branch changes as the user switches edit branches),
// so the extension itself stays stable across the editor's lifetime.
export function referenceSuggestExtension(getContext: () => ReferenceSuggestContext): Extension {
  const source: CompletionSource = async (context) => {
    const match = findReferenceCompletionMatch(context.state, context.pos);
    // Only bracketed `[@…]` refs: `/suggest` inserts `[@id]`, which is wrong for
    // the narrative `@…` form Coflat's native source already handles.
    if (!match || match.kind !== "bracketed") return null;
    const { owner, repo, branch, path } = getContext();
    let suggestions;
    try {
      ({ suggestions } = await api.suggest(owner, repo, { trigger: "[@", prefix: match.query, branch, path }));
    } catch (_err) {
      return null;
    }
    if (context.aborted) return null;
    return buildReferenceCompletionResult(match.from, match.to, suggestions);
  };
  return extraCompletionSourcesFacet.of(source);
}
