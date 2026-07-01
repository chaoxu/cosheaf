import {
  extractFirstH1 as extractCoflatFirstH1,
  parseFrontmatter as parseCoflatFrontmatter,
  relativeMarkdownReferencePathFromDocument,
} from "@chaoxu/coflat/parse";
import { extractCoflatXrefTargets } from "../../shared/coflat-xrefs";
import { MAX_ASSET_BYTES, MAX_ASSET_DISPLAY } from "../../shared/conventions";
import { rawRepoBranchFileHref } from "../../shared/url";

export interface Suggestion {
  id: string;
  insert: string;
  display: string;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function relativeAssetPath(documentPath: string, assetPath: string): string {
  return relativeMarkdownReferencePathFromDocument(documentPath, assetPath);
}

export function rawRepoFileHref(owner: string, repo: string, branch: string, path: string): string {
  return rawRepoBranchFileHref(owner, repo, branch, path);
}

export async function fetchRawRepoFile(owner: string, repo: string, branch: string, path: string): Promise<Response> {
  const res = await fetch(rawRepoFileHref(owner, repo, branch, path), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Unable to read ${path}: HTTP ${res.status}`);
  return res;
}

export function sizeAssetRejection(file: File): { reject: string } | null {
  return file.size > MAX_ASSET_BYTES ? { reject: `asset exceeds ${MAX_ASSET_DISPLAY}` } : null;
}

// Fire an app-wide toast (cosheaf-toast.js, loaded by the page shell). A no-op
// if the script hasn't loaded; toasts are for discrete events (merge/PR/errors/
// upload), never for per-save feedback.
export function toast(message: string, kind: "info" | "success" | "error" = "info"): void {
  (window as unknown as { cosheafToast?: (m: string, o?: { kind?: string }) => void }).cosheafToast?.(message, { kind });
}

// Persistent, glance-able save-state label + style class (#184), priority-ordered:
// in-flight > error > unsaved > last saved > idle. Discrete events (merge/PR/
// upload) go to toasts instead, so constant saves don't spam.
export function saveState(args: {
  busy: boolean;
  saveError: string | null;
  dirty: boolean;
  lastSavedAt: string | null;
}): { text: string; cls: string } {
  if (args.busy) return { text: "Saving…", cls: "saving" };
  if (args.saveError) return { text: "Save failed", cls: "error" };
  if (args.dirty) return { text: "Unsaved changes", cls: "dirty" };
  if (args.lastSavedAt) return { text: `Saved · ${args.lastSavedAt}`, cls: "saved" };
  return { text: "", cls: "idle" };
}

export function currentDocumentSuggestions(source: string, prefix: string): Suggestion[] {
  const parsed = parseCoflatFrontmatter(source);
  const frontmatter = (parsed.frontmatter ?? {}) as Record<string, unknown>;
  const suggestions: Suggestion[] = [];
  const add = (id: string, title: string | null, detail: string) => {
    if (!id || !matchesSuggestion(id, title, prefix)) return;
    suggestions.push({
      id,
      insert: `[@${id}]`,
      display: title ? `${id} — ${title} (${detail})` : `${id} (${detail})`,
    });
  };
  if (typeof frontmatter.id === "string") {
    add(
      frontmatter.id,
      typeof frontmatter.title === "string" ? frontmatter.title : extractCoflatFirstH1(parsed.body),
      "current page",
    );
  }
  for (const target of extractCoflatXrefTargets(source)) add(target.id, target.label, "current page");
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.id)) return false;
    seen.add(suggestion.id);
    return true;
  });
}

export function matchesSuggestion(id: string, title: string | null, prefix: string): boolean {
  const needle = prefix.trim().toLowerCase();
  if (!needle) return true;
  return id.toLowerCase().startsWith(needle) || Boolean(title?.toLowerCase().includes(needle));
}
