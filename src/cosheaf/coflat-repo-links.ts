import { resolveMarkdownReferencePathFromDocument } from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { pdfDisplaySuffix, previewAssetPath } from "../../shared/asset-previews";
import { rawRepoBranchFileHref, repoBranchFileHref } from "../../shared/url";
import type { CoflatDocumentPayload } from "./coflat-document-context";

export function resolveRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  const sourceView = isLineFragment(hash) ? "?view=source" : "";
  return `${repoBranchFileHref(payload.owner, payload.repo, payload.branch, normalized)}${sourceView}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  return `${rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), normalized)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoDisplayAssetLink(payload: CoflatDocumentPayload, href: string): string | null {
  const clean = href.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const normalized = normalizeRepoPath(payload, withoutHash);
  if (!normalized || normalized.split("/").includes("..")) return null;
  const assetPath = previewAssetPath(normalized, payload.assetPreviewPaths);
  return `${rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), assetPath)}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

export function resolveRawRepoAssetPath(payload: CoflatDocumentPayload, path: string, purpose: "source" | "display"): string | null {
  const clean = path.trim();
  if (!clean || clean.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("/")) {
    return null;
  }
  const [withoutHash, hash = ""] = clean.split("#", 2);
  const decodedPath = decodeMarkdownPathHref(withoutHash);
  if (!decodedPath || decodedPath.split("/").includes("..")) return null;
  const assetPath = purpose === "display" ? previewAssetPath(decodedPath, payload.assetPreviewPaths) : decodedPath;
  const url = rawRepoBranchFileHref(payload.owner, payload.repo, rawResourceBranch(payload), assetPath);
  // A PDF figure with no sibling raster is served as a rendered PNG for display.
  const preview = purpose === "display" ? pdfDisplaySuffix(assetPath) : "";
  return `${url}${preview}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

function rawResourceBranch(payload: CoflatDocumentPayload): string {
  return payload.branchExists === false ? "main" : payload.branch;
}

function normalizeRepoPath(payload: CoflatDocumentPayload, href: string): string {
  return resolveMarkdownReferencePathFromDocument(payload.path, decodeMarkdownPathHref(href));
}

function decodeMarkdownPathHref(href: string): string {
  try {
    return decodeURI(href);
  } catch (_error) {
    return href;
  }
}

function isLineFragment(hash: string): boolean {
  return /^L\d+(?:-(?:L)?\d+)?$/.test(hash);
}

// The coflat link resolver shared by the full reader context and the link-only
// compose island (#20): turns a relative repo link into a same-origin href, and
// returns null for a non-resolvable link — both surfaces must agree on that null
// contract, so it lives in one place.
export function coflatLinkResolver(payload: CoflatDocumentPayload): DocumentContext["linkResolver"] {
  return {
    resolve: (href) => {
      const resolved = resolveRepoLink(payload, href);
      return resolved ? { href: resolved } : null;
    },
  };
}
