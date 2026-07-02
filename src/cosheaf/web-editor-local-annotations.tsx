import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalAnnotation, LocalAnnotationKind } from "../../shared/local-annotations";
import { ApiError, api } from "./api";
import { toast } from "./web-editor-helpers";

interface AnnotationDraft {
  kind: LocalAnnotationKind;
  body: string;
}

interface LocalAnnotationsControllerOptions {
  enabled: boolean;
  owner: string;
  repo: string;
  path: string;
  captureCursor: () => void;
  insertAnchor: (annotation: LocalAnnotation) => void;
  removeAnchor: (annotation: LocalAnnotation) => void;
}

export interface LocalAnnotationsController {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  openCount: number;
  ready: boolean;
  annotations: LocalAnnotation[];
  showOpenOnly: boolean;
  setShowOpenOnly: (showOpenOnly: boolean | ((showOpenOnly: boolean) => boolean)) => void;
  draft: AnnotationDraft;
  setDraft: (draft: AnnotationDraft | ((draft: AnnotationDraft) => AnnotationDraft)) => void;
  replies: Record<string, string>;
  setReplies: (replies: Record<string, string> | ((replies: Record<string, string>) => Record<string, string>)) => void;
  busyId: string | null;
  error: string | null;
  focusedId: string | null;
  captureCursor: () => void;
  focusAnnotation: (id: string) => void;
  focusNextOpen: () => void;
  createAnnotation: () => Promise<void>;
  insertAnchor: (annotation: LocalAnnotation) => void;
  deleteAnnotation: (annotation: LocalAnnotation) => Promise<void>;
  updateStatus: (annotation: LocalAnnotation, status: LocalAnnotation["status"]) => Promise<void>;
  reply: (annotation: LocalAnnotation) => Promise<void>;
}

function replaceAnnotation(items: LocalAnnotation[], annotation: LocalAnnotation): LocalAnnotation[] {
  const next = items.filter((item) => item.id !== annotation.id);
  next.push(annotation);
  next.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return next;
}

export function useLocalAnnotationsController(options: LocalAnnotationsControllerOptions): LocalAnnotationsController {
  const { captureCursor, enabled, insertAnchor, owner, path, removeAnchor, repo } = options;
  const [open, setOpen] = useState(false);
  const [annotations, setAnnotations] = useState<LocalAnnotation[]>([]);
  const [showOpenOnly, setShowOpenOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<AnnotationDraft>({ kind: "comment", body: "" });
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnnotations([]);
      setReady(false);
      return;
    }
    let cancelled = false;
    setReady(false);
    void api.listLocalAnnotations(owner, repo, { path }).then((result) => {
      if (cancelled) return;
      setAnnotations(result.annotations);
      setReady(true);
    }).catch((err) => {
      if (cancelled) return;
      setAnnotations([]);
      setReady(false);
      setError(err instanceof ApiError && err.status !== 404 ? err.message : null);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, owner, path, repo]);

  const createAnnotation = useCallback(async () => {
    if (!enabled || !draft.body.trim()) return;
    setBusyId("new");
    setError(null);
    try {
      const result = await api.createLocalAnnotation(owner, repo, {
        path,
        kind: draft.kind,
        body: draft.body,
      });
      setAnnotations((items) => replaceAnnotation(items, result.annotation));
      setDraft((current) => ({ ...current, body: "" }));
      insertAnchor(result.annotation);
      setOpen(true);
      toast("Annotation added");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "annotation failed";
      setError(message);
      toast(`Annotation failed: ${message}`, "error");
    } finally {
      setBusyId(null);
    }
  }, [draft.body, draft.kind, enabled, insertAnchor, owner, path, repo]);

  const updateStatus = useCallback(async (annotation: LocalAnnotation, status: LocalAnnotation["status"]) => {
    setBusyId(annotation.id);
    setError(null);
    try {
      const result = await api.updateLocalAnnotation(owner, repo, annotation.id, { status });
      setAnnotations((items) => replaceAnnotation(items, result.annotation));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "annotation update failed";
      setError(message);
      toast(`Annotation update failed: ${message}`, "error");
    } finally {
      setBusyId(null);
    }
  }, [owner, repo]);

  const deleteAnnotation = useCallback(async (annotation: LocalAnnotation) => {
    setBusyId(annotation.id);
    setError(null);
    try {
      await api.deleteLocalAnnotation(owner, repo, annotation.id);
      removeAnchor(annotation);
      setAnnotations((items) => items.filter((item) => item.id !== annotation.id));
      setReplies((items) => {
        const next = { ...items };
        delete next[annotation.id];
        return next;
      });
      setFocusedId((id) => (id === annotation.id ? null : id));
      toast("Annotation removed");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "annotation delete failed";
      setError(message);
      toast(`Annotation delete failed: ${message}`, "error");
    } finally {
      setBusyId(null);
    }
  }, [owner, removeAnchor, repo]);

  const reply = useCallback(async (annotation: LocalAnnotation) => {
    const body = replies[annotation.id]?.trim() ?? "";
    if (!body) return;
    setBusyId(annotation.id);
    setError(null);
    try {
      const result = await api.addLocalAnnotationMessage(owner, repo, annotation.id, { body });
      setAnnotations((items) => replaceAnnotation(items, result.annotation));
      setReplies((items) => ({ ...items, [annotation.id]: "" }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "reply failed";
      setError(message);
      toast(`Reply failed: ${message}`, "error");
    } finally {
      setBusyId(null);
    }
  }, [owner, repo, replies]);

  const openCount = useMemo(() => annotations.filter((item) => item.status === "open").length, [annotations]);
  const focusAnnotation = useCallback((id: string) => {
    setFocusedId(id);
    setOpen(true);
  }, []);
  const focusNextOpen = useCallback(() => {
    const openAnnotations = annotations.filter((annotation) => annotation.status === "open");
    if (openAnnotations.length === 0) return;
    const currentIndex = focusedId ? openAnnotations.findIndex((annotation) => annotation.id === focusedId) : -1;
    const next = openAnnotations[(currentIndex + 1) % openAnnotations.length];
    if (next) focusAnnotation(next.id);
  }, [annotations, focusedId, focusAnnotation]);

  return {
    enabled,
    open,
    setOpen,
    openCount,
    ready,
    annotations,
    showOpenOnly,
    setShowOpenOnly,
    draft,
    setDraft,
    replies,
    setReplies,
    busyId,
    error,
    focusedId,
    captureCursor,
    focusAnnotation,
    focusNextOpen,
    createAnnotation,
    insertAnchor,
    deleteAnnotation,
    updateStatus,
    reply,
  };
}

export function LocalAnnotationsDrawer({ controller }: { controller: LocalAnnotationsController }) {
  if (!controller.enabled || !controller.open) return null;
  const visibleAnnotations = controller.showOpenOnly
    ? controller.annotations.filter((annotation) => annotation.status === "open")
    : controller.annotations;
  return (
    <section className="local-annotations" data-testid="local-annotations" aria-label="Local annotations">
      <div className="local-annotations-head">
        <strong>Annotations</strong>
        <span>{controller.openCount} open</span>
        <label className="local-annotations-filter">
          <input
            type="checkbox"
            checked={controller.showOpenOnly}
            onChange={(event) => controller.setShowOpenOnly(event.target.checked)}
          />
          Open only
        </label>
        <button
          type="button"
          className="button small subtle"
          disabled={controller.openCount === 0}
          onClick={controller.focusNextOpen}
        >
          Next open
        </button>
        <button type="button" className="button small subtle" onClick={() => controller.setOpen(false)}>
          Close
        </button>
      </div>
      <div className="local-annotation-compose">
        <select
          aria-label="Annotation kind"
          value={controller.draft.kind}
          disabled={controller.busyId === "new"}
          onChange={(event) => controller.setDraft((draft) => ({ ...draft, kind: event.target.value as LocalAnnotationKind }))}
        >
          <option value="comment">Comment</option>
          <option value="task">Task</option>
        </select>
        <textarea
          value={controller.draft.body}
          disabled={controller.busyId === "new"}
          placeholder="New note"
          rows={2}
          onChange={(event) => controller.setDraft((draft) => ({ ...draft, body: event.target.value }))}
        />
        <button
          type="button"
          className="button primary"
          disabled={controller.busyId === "new" || !controller.draft.body.trim()}
          onPointerDown={controller.captureCursor}
          onClick={() => void controller.createAnnotation()}
        >
          Add
        </button>
      </div>
      {controller.error ? <div className="local-annotation-error" role="alert">{controller.error}</div> : null}
      <div className="local-annotations-list">
        {!controller.ready ? (
          <div className="local-annotation-empty">Loading...</div>
        ) : visibleAnnotations.length === 0 ? (
          <div className="local-annotation-empty">No annotations.</div>
        ) : (
          visibleAnnotations.map((annotation) => {
            const first = annotation.messages[0];
            const reply = controller.replies[annotation.id] ?? "";
            return (
              <article
                className={`local-annotation local-annotation--${annotation.status}${controller.focusedId === annotation.id ? " is-focused" : ""}`}
                key={annotation.id}
              >
                <div className="local-annotation-top">
                  <span className="meta-pill">{annotation.kind}</span>
                  <code>{annotation.anchor}</code>
                  <span>{annotation.status}</span>
                </div>
                {first ? (
                  <p className="local-annotation-body">{first.body}</p>
                ) : null}
                {annotation.messages.length > 1 ? (
                  <div className="local-annotation-thread">
                    {annotation.messages.slice(1).map((message) => (
                      <p key={message.id}>{message.body}</p>
                    ))}
                  </div>
                ) : null}
                <div className="local-annotation-actions">
                  <button
                    type="button"
                    className="button small"
                    onPointerDown={controller.captureCursor}
                    onClick={() => controller.insertAnchor(annotation)}
                  >
                    Insert anchor
                  </button>
                  <button
                    type="button"
                    className="button small"
                    disabled={controller.busyId === annotation.id}
                    onClick={() => void controller.updateStatus(annotation, annotation.status === "open" ? "resolved" : "open")}
                  >
                    {annotation.status === "open" ? "Resolve" : "Reopen"}
                  </button>
                  <button
                    type="button"
                    className="button small danger"
                    disabled={controller.busyId === annotation.id}
                    onClick={() => void controller.deleteAnnotation(annotation)}
                  >
                    Delete
                  </button>
                </div>
                <div className="local-annotation-reply">
                  <input
                    value={reply}
                    disabled={controller.busyId === annotation.id}
                    placeholder="Reply"
                    onChange={(event) => controller.setReplies((items) => ({ ...items, [annotation.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void controller.reply(annotation);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="button small"
                    disabled={controller.busyId === annotation.id || !reply.trim()}
                    onClick={() => void controller.reply(annotation)}
                  >
                    Reply
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
