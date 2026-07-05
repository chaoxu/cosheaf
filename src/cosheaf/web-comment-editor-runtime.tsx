import { extractReferences } from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import type { ReactElement } from "react";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { coflatLinkResolver, loadCoflatDocumentContext } from "./coflat-document-context";
import { readEditorMode } from "./document-theme";
import { MarkdownEditor } from "./editor";
import "@chaoxu/coflat/style.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

interface ComposeConfig {
  owner: string;
  repo: string;
  branch: string;
}

function composeContext(config: ComposeConfig): DocumentContext {
  const payload = { source: "", owner: config.owner, repo: config.repo, branch: config.branch, path: "" };
  return { linkResolver: coflatLinkResolver(payload) };
}

function referencedKeySignature(source: string): string {
  return [
    ...new Set(
      extractReferences(source)
        .filter((ref) => ref.kind === "crossref" && ref.key)
        .map((ref) => ref.key as string),
    ),
  ].join("\n");
}

function CommentEditor({ textarea, config }: { textarea: HTMLTextAreaElement; config: ComposeConfig }): ReactElement {
  const [value, setValue] = useState(textarea.value);
  const [mode] = useState<"rich" | "source">(() => readEditorMode(document.body.dataset.cosheafUser));
  const [documentContext, setDocumentContext] = useState<DocumentContext>(() => composeContext(config));
  const latestValueRef = useRef(value);
  const refSignature = useMemo(() => referencedKeySignature(value), [value]);
  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);
  useEffect(() => {
    if (mode !== "rich" || !refSignature) {
      setDocumentContext(composeContext(config));
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const payload = { source: latestValueRef.current, owner: config.owner, repo: config.repo, branch: config.branch, path: "" };
      void loadCoflatDocumentContext(payload).then((ctx) => {
        if (!cancelled) setDocumentContext(ctx);
      }).catch(() => {
        if (!cancelled) setDocumentContext(composeContext(config));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config, mode, refSignature]);
  return (
    <div className="coflat-compose-editor cf-theme-scope">
      <MarkdownEditor
        value={value}
        mode={mode}
        documentContext={documentContext}
        testId="comment-editor"
        onChange={(next) => {
          setValue(next);
          textarea.value = next;
        }}
      />
    </div>
  );
}

export function enhance(container: HTMLElement): void {
  if (container.dataset.mounted) return;
  const textarea = container.querySelector("textarea");
  if (!textarea) return;
  container.dataset.mounted = "1";

  const config: ComposeConfig = {
    owner: container.dataset.owner ?? "",
    repo: container.dataset.repo ?? "",
    branch: container.dataset.branch ?? "main",
  };
  const wasRequired = textarea.required;

  textarea.hidden = true;
  textarea.required = false;

  const mount = container.querySelector<HTMLElement>(".coflat-compose-mount") ?? container;
  const root = createRoot(mount);
  root.render(
    <StrictMode>
      <CommentEditor textarea={textarea} config={config} />
    </StrictMode>,
  );

  const form = textarea.form;
  if (form) {
    form.addEventListener("submit", (event) => {
      if (wasRequired && textarea.value.trim() === "") {
        event.preventDefault();
        mount.querySelector<HTMLElement>(".cm-editor")?.focus();
      }
    });
  }
}

export function enhanceIn(scope: ParentNode): void {
  for (const container of scope.querySelectorAll<HTMLElement>("[data-coflat-compose]")) enhance(container);
}
