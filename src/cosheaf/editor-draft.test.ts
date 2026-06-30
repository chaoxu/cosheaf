import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDraft, readDraft, restoredDraftFreshness, writeDraft } from "./editor-draft";

function stubLocalStorage(): Map<string, string> {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor drafts", () => {
  it("keeps older drafts without a base sha as unknown so restore preserves the loaded CAS base", () => {
    const storage = stubLocalStorage();
    storage.set("cosheaf:draft:owner/repo/main/notes.md", JSON.stringify({ source: "# Draft\n" }));

    expect(readDraft("owner", "repo", "main", "notes.md")).toEqual({
      source: "# Draft\n",
      savedAt: 0,
    });
  });

  it("treats unmarked older null base shas as unknown, not known-absent", () => {
    const storage = stubLocalStorage();
    storage.set(
      "cosheaf:draft:owner/repo/main/notes.md",
      JSON.stringify({ source: "# Draft\n", baseSha: null, savedAt: 123 }),
    );

    expect(readDraft("owner", "repo", "main", "notes.md")).toEqual({
      source: "# Draft\n",
      savedAt: 123,
    });
  });

  it("round-trips the saved base sha for current drafts", () => {
    stubLocalStorage();

    writeDraft("owner", "repo", "branch", "notes.md", {
      source: "# Draft\n",
      baseSha: "blob-sha",
      baseShaKnown: true,
      savedAt: 123,
    });

    expect(readDraft("owner", "repo", "branch", "notes.md")).toEqual({
      source: "# Draft\n",
      baseSha: "blob-sha",
      baseShaKnown: true,
      savedAt: 123,
    });
  });

  it("round-trips the live path for unsaved renames", () => {
    stubLocalStorage();

    writeDraft("owner", "repo", "branch", "old.md", {
      source: "# Draft\n",
      path: "new.md",
      baseSha: "blob-sha",
      baseShaKnown: true,
      savedAt: 123,
    });

    expect(readDraft("owner", "repo", "branch", "old.md")).toEqual({
      source: "# Draft\n",
      path: "new.md",
      baseSha: "blob-sha",
      baseShaKnown: true,
      savedAt: 123,
    });
  });

  it("scopes drafts by origin id when provided", () => {
    const storage = stubLocalStorage();

    writeDraft("owner", "repo", "branch", "notes.md", {
      source: "# Scoped draft\n",
      savedAt: 123,
    }, { originId: "worktree-a" });

    expect(storage.has("cosheaf:draft:owner/repo/branch/notes.md")).toBe(false);
    expect(storage.has("cosheaf:draft:worktree-a:owner/repo/branch/notes.md")).toBe(true);
    expect(readDraft("owner", "repo", "branch", "notes.md", { originId: "worktree-a" })).toEqual({
      source: "# Scoped draft\n",
      savedAt: 123,
    });
    expect(readDraft("owner", "repo", "branch", "notes.md", { originId: "worktree-b" })).toBeNull();
  });

  it("falls back to a legacy unscoped draft under an origin scope", () => {
    const storage = stubLocalStorage();
    storage.set("cosheaf:draft:owner/repo/main/notes.md", JSON.stringify({ source: "# Legacy draft\n", savedAt: 456 }));

    expect(readDraft("owner", "repo", "main", "notes.md", { originId: "worktree-a" })).toEqual({
      source: "# Legacy draft\n",
      savedAt: 456,
    });
  });

  it("clears scoped and legacy draft keys for the same page", () => {
    const storage = stubLocalStorage();
    storage.set("cosheaf:draft:owner/repo/main/notes.md", JSON.stringify({ source: "# Legacy draft\n", savedAt: 1 }));
    storage.set("cosheaf:draft:worktree-a:owner/repo/main/notes.md", JSON.stringify({ source: "# Scoped draft\n", savedAt: 2 }));

    clearDraft("owner", "repo", "main", "notes.md", { originId: "worktree-a" });

    expect(storage.has("cosheaf:draft:owner/repo/main/notes.md")).toBe(false);
    expect(storage.has("cosheaf:draft:worktree-a:owner/repo/main/notes.md")).toBe(false);
  });

  it("round-trips a known-absent base sha for current drafts", () => {
    stubLocalStorage();

    writeDraft("owner", "repo", "branch", "new.md", {
      source: "# Draft\n",
      baseSha: null,
      baseShaKnown: true,
      savedAt: 456,
    });

    expect(readDraft("owner", "repo", "branch", "new.md")).toEqual({
      source: "# Draft\n",
      baseSha: null,
      baseShaKnown: true,
      savedAt: 456,
    });
  });

  it("round-trips the fallback source sha for current drafts", () => {
    stubLocalStorage();

    writeDraft("owner", "repo", "branch", "new.md", {
      source: "# Draft\n",
      baseSha: null,
      baseShaKnown: true,
      sourceSha: "main-sha",
      sourceShaKnown: true,
      savedAt: 789,
    });

    expect(readDraft("owner", "repo", "branch", "new.md")).toEqual({
      source: "# Draft\n",
      baseSha: null,
      baseShaKnown: true,
      sourceSha: "main-sha",
      sourceShaKnown: true,
      savedAt: 789,
    });
  });

  it("clears the current page fallback source sha when restoring a current draft without one", () => {
    expect(restoredDraftFreshness(
      { baseSha: null, sourceSha: "newer-main-sha" },
      { source: "# Draft\n", baseSha: null, baseShaKnown: true, savedAt: 1 },
    )).toEqual({ baseSha: null, sourceSha: undefined });
  });

  it("preserves loaded freshness metadata for legacy drafts with unknown base", () => {
    expect(restoredDraftFreshness(
      { baseSha: null, sourceSha: "main-sha" },
      { source: "# Legacy draft\n", savedAt: 1 },
    )).toEqual({ baseSha: null, sourceSha: "main-sha" });
  });
});
