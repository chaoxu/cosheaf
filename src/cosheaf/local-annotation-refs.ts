// Local-annotation reference encoding shared by the editor's document context
// (host ref resolver) and the Workbench annotations island. A `[@local:<id>]`
// crossref renders as an inline "local note" marker; clicking it dispatches a
// window event the annotations drawer listens for.

const LOCAL_ANNOTATION_ID_RE = /^la_[a-z0-9]{12}$/;
const LOCAL_ANNOTATION_REF_PREFIX = "local:";
export const LOCAL_ANNOTATION_CLICK_EVENT = "cosheaf:local-annotation-click";

export function localAnnotationIdFromRef(key: string): string | null {
  if (!key.startsWith(LOCAL_ANNOTATION_REF_PREFIX)) return null;
  const id = key.slice(LOCAL_ANNOTATION_REF_PREFIX.length);
  return LOCAL_ANNOTATION_ID_RE.test(id) ? id : null;
}

export function localAnnotationReference(key: string): { content: string; className: string; onClick: (event: MouseEvent) => void } | null {
  const id = localAnnotationIdFromRef(key);
  if (!id) return null;
  return {
    content: "local note",
    className: "cf-local-annotation",
    onClick(event) {
      event.preventDefault();
      if (typeof window === "undefined") return;
      window.dispatchEvent(new CustomEvent(LOCAL_ANNOTATION_CLICK_EVENT, { detail: { id } }));
    },
  };
}
