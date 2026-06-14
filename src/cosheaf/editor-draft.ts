// Local draft persistence for the page editor (#162). Autosave writes the
// in-progress source to a local draft instead of committing to Forgejo on every
// tick; an explicit Save/Cmd-S commits and clears the draft. Drafts are small
// markdown documents, so localStorage is sufficient (idb-keyval is the
// documented upgrade path if drafts ever grow). The draft survives reload and
// navigation, so work is never lost between commits.

export interface EditorDraft {
  source: string;
  // The file sha the draft was branched from, when known (null today — the
  // typed file route doesn't surface a sha; reserved for a freshness check).
  baseSha: string | null;
  savedAt: number;
}

function draftKey(owner: string, repo: string, branch: string, path: string): string {
  return `cosheaf:draft:${owner}/${repo}/${branch}/${path}`;
}

export function readDraft(owner: string, repo: string, branch: string, path: string): EditorDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(owner, repo, branch, path));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorDraft;
    return typeof parsed?.source === "string" ? parsed : null;
  } catch (_err) {
    // Corrupt/blocked storage: treat as no draft rather than break the editor.
    return null;
  }
}

export function writeDraft(owner: string, repo: string, branch: string, path: string, draft: EditorDraft): void {
  try {
    localStorage.setItem(draftKey(owner, repo, branch, path), JSON.stringify(draft));
  } catch (_err) {
    // Storage full / disabled (private mode): drafting is best-effort.
  }
}

export function clearDraft(owner: string, repo: string, branch: string, path: string): void {
  try {
    localStorage.removeItem(draftKey(owner, repo, branch, path));
  } catch (_err) {
    // Nothing to recover from when clearing fails.
  }
}
