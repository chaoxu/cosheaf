import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { extractReferences } from "@chaoxu/coflat/parse";
import type { DocumentContext } from "@chaoxu/coflat/reader";
import { MarkdownEditor, type AutocompleteSource } from "./editor";
import { readEditorMode } from "./document-theme";
import { coflatDocumentContext, coflatLinkResolver, loadCoflatRefs } from "./coflat-document-context";
import { api } from "./api";
import "@chaoxu/coflat/style.css";
import "@chaoxu/coflat/themes/blueprint-book.css";
import "./globals.css";

// Progressive-enhancement compose island for coflat workspaces. Each
// `[data-coflat-compose]` container holds exactly one real `<textarea>` form
// field; we mount a coflat editor over it and mirror its value back into the
// textarea, which stays the source of truth for native form submission. The
// island is gated server-side on COFLAT_FORMAT_ID, so it only ships markup it
// should enhance.

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
  const [mode, setMode] = useState<"rich" | "source">(() => readEditorMode(document.body.dataset.cosheafUser));
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
      void loadCoflatRefs(payload).then((refs) => {
        if (!cancelled) setDocumentContext(coflatDocumentContext(payload, refs));
      }).catch(() => {
        if (!cancelled) setDocumentContext(composeContext(config));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [config, mode, refSignature]);
  const autocompleteSources = useMemo<readonly AutocompleteSource[]>(
    () => [
      {
        trigger: "[@",
        suggest: async (prefix, env) => {
          if (env.signal.aborted) return [];
          try {
            return (await api.suggest(config.owner, config.repo, { trigger: "[@", prefix, branch: config.branch, limit: 10 })).suggestions;
          } catch (_err) {
            return [];
          }
        },
      },
    ],
    [config],
  );
  return (
    <div className="coflat-compose-editor cf-theme-scope">
      <div className="coflat-compose-toolbar">
        <button type="button" className={mode === "rich" ? "active" : ""} onClick={() => setMode("rich")} aria-pressed={mode === "rich"}>
          Rich
        </button>
        <button type="button" className={mode === "source" ? "active" : ""} onClick={() => setMode("source")} aria-pressed={mode === "source"}>
          Source
        </button>
      </div>
      <MarkdownEditor
        value={value}
        mode={mode}
        documentContext={documentContext}
        autocompleteSources={autocompleteSources}
        testId="comment-editor"
        onChange={(next) => {
          setValue(next);
          // The native textarea is the submitted form field; keep it in sync on
          // every keystroke so a plain form POST carries the edited body.
          textarea.value = next;
        }}
      />
    </div>
  );
}

function enhance(container: HTMLElement): void {
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

  // Hide the textarea but keep it in the form as the submitted field. A hidden
  // `required` input would block native submit with no visible control to focus,
  // so drop `required` and re-enforce non-empty ourselves on submit.
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
      // The editor already syncs on change, but sync once more in case a submit
      // races a pending change. If the field was required, block empty submits
      // and surface the editor instead of a hidden invalid control.
      if (wasRequired && textarea.value.trim() === "") {
        event.preventDefault();
        mount.querySelector<HTMLElement>(".cm-editor")?.focus();
      }
    });
  }
}

function enhanceIn(scope: ParentNode): void {
  for (const container of scope.querySelectorAll<HTMLElement>("[data-coflat-compose]")) enhance(container);
}

enhanceIn(document);

// Some compose forms appear after initial load (e.g. a disclosure revealing an
// inline edit form), so watch for new containers and enhance them too.
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches("[data-coflat-compose]")) enhance(node);
      enhanceIn(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
