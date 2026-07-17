import {
  createReaderCitationClusterPreviewBody,
  type DocumentContext,
  hydrateReaderHoverPreviews,
  hydrateReferences,
} from "@chaoxu/coflat/reader";
import { useEffect, useRef, useState } from "react";
import {
  type CoflatDocumentPayload,
  coflatDocumentContextSignature,
  loadCoflatDocumentContext,
} from "./coflat-document-context";

// Read-only document-context concern for the page editor, extracted from
// web-editor.tsx. Loads the Coflat DocumentContext (crossrefs, citations, asset
// resolution) for the current payload, deduping by signature and sharing an
// in-flight promise so a re-render with the same signature never re-fetches, and
// keeps rendered references/hover previews hydrated as the editor DOM mutates.
// No editor-write coupling: it only reads `payload` and reports readiness.
export function useCoflatDocumentContext(payload: CoflatDocumentPayload): {
  documentContext: DocumentContext | null;
  editorContextReady: boolean;
} {
  const [documentContext, setDocumentContext] = useState<DocumentContext | null>(null);
  const [editorContextReady, setEditorContextReady] = useState(false);
  const contextLoadedRef = useRef(false);
  const contextSignatureRef = useRef<string | null>(null);
  const documentContextRef = useRef<DocumentContext | null>(null);
  const documentContextLoadRef = useRef<{ signature: string; promise: Promise<DocumentContext> } | null>(null);

  const { source, owner, repo, branch, branchExists, path, mathMacros, assetPreviewPaths, bibliography, csl } = payload;

  useEffect(() => {
    let cancelled = false;
    const signature = coflatDocumentContextSignature(payload);
    if (contextSignatureRef.current === signature && documentContextRef.current) {
      setEditorContextReady(true);
      return;
    }
    contextSignatureRef.current = signature;
    if (!contextLoadedRef.current) setEditorContextReady(false);
    let load = documentContextLoadRef.current?.signature === signature
      ? documentContextLoadRef.current.promise
      : null;
    if (!load) {
      load = loadCoflatDocumentContext(payload);
      documentContextLoadRef.current = { signature, promise: load };
    }
    void load.then((ctx) => {
      if (cancelled || contextSignatureRef.current !== signature) return;
      setDocumentContext(ctx);
      documentContextRef.current = ctx;
      contextLoadedRef.current = true;
      setEditorContextReady(true);
      if (documentContextLoadRef.current?.signature === signature) documentContextLoadRef.current = null;
    }).catch(() => {
      if (cancelled || contextSignatureRef.current !== signature) return;
      if (!contextLoadedRef.current) setEditorContextReady(false);
      if (documentContextLoadRef.current?.signature === signature) documentContextLoadRef.current = null;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, owner, repo, branch, branchExists, path, mathMacros, assetPreviewPaths, bibliography, csl]);

  useEffect(() => {
    if (!documentContext) return;
    const root = document.getElementById("web-editor-root");
    if (!root) return;
    let queued = false;
    const cleanupHoverPreviews = hydrateReaderHoverPreviews(root, {
      source,
      context: documentContext,
      previewForReference: (key) => createReaderCitationClusterPreviewBody(key, documentContext),
    });
    const reconcile = () => {
      queued = false;
      hydrateReferences(root, documentContext, {
        documentPath: path,
        source,
        surface: "editor",
      });
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(reconcile);
    };
    const refSelector = "[data-ref-key], .cf-citation";
    const nodeMayContainRefs = (node: Node): boolean => {
      if (!(node instanceof HTMLElement)) return false;
      return node.matches(refSelector) || Boolean(node.querySelector(refSelector));
    };
    schedule();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) =>
        (mutation.type === "attributes" && nodeMayContainRefs(mutation.target)) ||
        [...mutation.addedNodes].some(nodeMayContainRefs)
      )) {
        schedule();
      }
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-ref-key"] });
    return () => {
      observer.disconnect();
      cleanupHoverPreviews();
    };
  }, [source, path, documentContext]);

  return { documentContext, editorContextReady };
}
