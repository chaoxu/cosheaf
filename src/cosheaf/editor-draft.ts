// Local draft persistence for the page editor (#162). Autosave writes the
// in-progress source to a local draft instead of committing to Forgejo on every
// tick; an explicit Save/Cmd-S commits and clears the draft. Drafts are small
// markdown documents, so localStorage is sufficient (idb-keyval is the
// documented upgrade path if drafts ever grow). The draft survives reload and
// navigation, so work is never lost between commits.

export interface EditorDraft {
  source: string;
  path?: string;
  // The file sha the draft was branched from. `null` is meaningful only when
  // baseShaKnown is true: the draft was based on the target branch not having
  // this path yet. Legacy drafts left this unknown.
  baseSha?: string | null;
  baseShaKnown?: true;
  sourceSha?: string;
  sourceShaKnown?: true;
  savedAt: number;
}

export interface DraftFreshness {
  baseSha: string | null | undefined;
  sourceSha: string | undefined;
}

export interface DraftScope {
  originId?: string;
}

export function restoredDraftFreshness(current: DraftFreshness, draft: EditorDraft): DraftFreshness {
  const baseSha = draft.baseShaKnown ? (draft.baseSha ?? null) : current.baseSha;
  let sourceSha = current.sourceSha;
  if (draft.sourceShaKnown) {
    sourceSha = draft.sourceSha;
  } else if (draft.baseShaKnown) {
    sourceSha = undefined;
  }
  return { baseSha, sourceSha };
}

function legacyDraftKey(owner: string, repo: string, branch: string, path: string): string {
  return `cosheaf:draft:${owner}/${repo}/${branch}/${path}`;
}

function scopedOriginId(scope?: DraftScope): string | null {
  const originId = scope?.originId?.trim();
  return originId ? encodeURIComponent(originId) : null;
}

function draftKey(owner: string, repo: string, branch: string, path: string, scope?: DraftScope): string {
  const originId = scopedOriginId(scope);
  return originId ? `cosheaf:draft:${originId}:${owner}/${repo}/${branch}/${path}` : legacyDraftKey(owner, repo, branch, path);
}

function parseDraft(raw: string | null): EditorDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EditorDraft> | null;
    if (typeof parsed?.source !== "string") return null;
    const baseShaKnown = parsed.baseShaKnown === true || typeof parsed.baseSha === "string";
    const sourceShaKnown = parsed.sourceShaKnown === true || typeof parsed.sourceSha === "string";
    return {
      source: parsed.source,
      ...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
      ...(baseShaKnown
        ? {
            baseSha: typeof parsed.baseSha === "string" ? parsed.baseSha : null,
            baseShaKnown: true as const,
          }
        : {}),
      ...(sourceShaKnown && typeof parsed.sourceSha === "string"
        ? {
            sourceSha: parsed.sourceSha,
            sourceShaKnown: true as const,
          }
        : {}),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch (_err) {
    return null;
  }
}

export function readDraft(owner: string, repo: string, branch: string, path: string, scope?: DraftScope): EditorDraft | null {
  try {
    const scoped = parseDraft(localStorage.getItem(draftKey(owner, repo, branch, path, scope)));
    if (scoped || !scopedOriginId(scope)) return scoped;
    return parseDraft(localStorage.getItem(legacyDraftKey(owner, repo, branch, path)));
  } catch (_err) {
    // Corrupt/blocked storage: treat as no draft rather than break the editor.
    return null;
  }
}

export function writeDraft(owner: string, repo: string, branch: string, path: string, draft: EditorDraft, scope?: DraftScope): void {
  try {
    localStorage.setItem(draftKey(owner, repo, branch, path, scope), JSON.stringify(draft));
  } catch (_err) {
    // Storage full / disabled (private mode): drafting is best-effort.
  }
}

export function clearDraft(owner: string, repo: string, branch: string, path: string, scope?: DraftScope): void {
  try {
    localStorage.removeItem(draftKey(owner, repo, branch, path, scope));
    if (scopedOriginId(scope)) localStorage.removeItem(legacyDraftKey(owner, repo, branch, path));
  } catch (_err) {
    // Nothing to recover from when clearing fails.
  }
}
