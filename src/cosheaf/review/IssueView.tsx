// Issue detail surface: title, markdown body, threaded comments,
// close/reopen, new-comment composer.

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { api } from "../api";
import type { DependencyRow, IssueComment, IssueDetail, Label, Milestone, TimelineEvent } from "../api";
import { IssueBodyRender, type DocumentContext } from "../document-format/coflat-issue-render";

const muted = "text-[var(--cf-muted)]";

export function IssueView({
  workspaceSlug,
  number,
  currentForgejoUsername,
  canManageLabels,
  canPin = false,
  isPinned = false,
  onClose,
  onPinChanged,
  onOpenPageById,
  onOpenPath,
  onOpenNumber,
  documentContext,
}: {
  workspaceSlug: string;
  number: number;
  currentForgejoUsername?: string;
  canManageLabels?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onClose: () => void;
  onPinChanged?: () => void | Promise<void>;
  onOpenPageById?: (id: string) => void;
  onOpenPath?: (path: string, range: { from: number; to: number } | null, fragment: string | null) => void;
  onOpenNumber?: (n: number) => void;
  documentContext?: DocumentContext;
}): ReactElement {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [allMilestones, setAllMilestones] = useState<Milestone[]>([]);
  const [milestoneMenuOpen, setMilestoneMenuOpen] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [dependencies, setDependencies] = useState<DependencyRow[]>([]);
  const [blocks, setBlocks] = useState<DependencyRow[]>([]);
  const [addDepNum, setAddDepNum] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const refresh = async () => {
    try {
      const [det, cms, tl, deps, blks] = await Promise.all([
        api.getIssue(workspaceSlug, number),
        api.getIssueComments(workspaceSlug, number),
        api.getIssueTimeline(workspaceSlug, number),
        api.listIssueDependencies(workspaceSlug, number),
        api.listIssueBlocks(workspaceSlug, number),
      ]);
      setIssue(det);
      setComments(cms.comments);
      setTimeline(tl.events);
      setDependencies(deps.issues);
      setBlocks(blks.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load issue");
    }
  };

  useEffect(() => {
    void refresh();
    api.listLabels(workspaceSlug).then((r) => setAllLabels(r.labels)).catch(() => undefined);
    api.listMilestones(workspaceSlug, "open").then((r) => setAllMilestones(r.milestones)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, number]);

  async function toggleLabel(id: number) {
    if (!issue) return;
    const has = issue.labels.some((l) => l.id === id);
    const next = has
      ? issue.labels.filter((l) => l.id !== id).map((l) => l.id)
      : [...issue.labels.map((l) => l.id), id];
    await api.setIssueLabels(workspaceSlug, number, next);
    await refresh();
  }

  async function submitComment() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await api.createIssueComment(workspaceSlug, number, draft.trim());
      setDraft("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to comment");
    } finally {
      setBusy(false);
    }
  }

  async function toggleState() {
    if (!issue || busy) return;
    setBusy(true);
    try {
      if (issue.state === "open") await api.closeIssue(workspaceSlug, number);
      else await api.reopenIssue(workspaceSlug, number);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!issue) {
    return (
      <div className={cn("p-4 text-sm", muted)} data-testid="issue-view">
        {error ? `Failed: ${error}` : "Loading…"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="issue-view">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-[var(--cf-border)]">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className={cn(
              "px-1.5 py-0.5 rounded uppercase tracking-wide",
              issue.state === "open" ? "bg-green-500/15 text-green-700" : "bg-purple-500/15 text-purple-700",
            )}>
              {issue.state}
            </span>
            <span className={muted}>ISSUE</span>
            <span className={muted}>·</span>
            <span>by @{issue.author}</span>
            <span className={cn("ml-auto", muted)}>#{issue.number}</span>
          </div>
          <h1 className="text-lg font-semibold truncate">{issue.title}</h1>
          {(issue.labels.length > 0 || canManageLabels) && (
            <div className="flex flex-wrap items-center gap-1 mt-1 relative">
              {issue.labels.map((l) => (
                <span
                  key={l.id}
                  data-testid={`label-chip-${l.id}`}
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: `#${l.color}33`, color: `#${l.color}` }}
                >
                  {l.name}
                </span>
              ))}
              {canManageLabels && (
                <div className="relative">
                  <button
                    type="button"
                    data-testid="label-add"
                    onClick={() => setLabelMenuOpen((v) => !v)}
                    className={cn("text-[11px] underline opacity-70", muted)}
                  >
                    + label
                  </button>
                  {labelMenuOpen && (
                    <div className="absolute z-10 top-full mt-1 left-0 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] p-1 min-w-[160px] shadow">
                      {allLabels.length === 0 && (
                        <div className={cn("text-xs px-2 py-1", muted)}>No labels defined.</div>
                      )}
                      {allLabels.map((l) => {
                        const checked = issue.labels.some((x) => x.id === l.id);
                        return (
                          <button
                            key={l.id}
                            type="button"
                            data-testid={`label-toggle-${l.id}`}
                            onClick={() => toggleLabel(l.id)}
                            className="flex items-center gap-2 w-full px-2 py-1 text-xs hover:bg-[var(--cf-hover)] rounded"
                          >
                            <span aria-hidden>{checked ? "✓" : " "}</span>
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ backgroundColor: `#${l.color}` }}
                            />
                            <span>{l.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {(issue.milestone || canManageLabels) && (
            <div className="flex flex-wrap items-center gap-1 mt-1 relative">
              {issue.milestone && (
                <span
                  data-testid={`milestone-chip-${issue.milestone.id}`}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700"
                  title="Milestone"
                >
                  🎯 {issue.milestone.title}
                </span>
              )}
              {canManageLabels && (
                <div className="relative">
                  <button
                    type="button"
                    data-testid="milestone-pick"
                    onClick={() => setMilestoneMenuOpen((v) => !v)}
                    className={cn("text-[11px] underline opacity-70", muted)}
                  >
                    {issue.milestone ? "change" : "+ milestone"}
                  </button>
                  {milestoneMenuOpen && (
                    <div className="absolute z-10 top-full mt-1 left-0 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] p-1 min-w-[180px] shadow">
                      {allMilestones.length === 0 && (
                        <div className={cn("text-xs px-2 py-1", muted)}>No open milestones.</div>
                      )}
                      <button
                        type="button"
                        data-testid="milestone-clear"
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api.setIssueMilestone(workspaceSlug, number, null);
                            setMilestoneMenuOpen(false);
                            await refresh();
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="flex items-center gap-2 w-full px-2 py-1 text-xs hover:bg-[var(--cf-hover)] rounded"
                      >
                        <span aria-hidden>{!issue.milestone ? "✓" : " "}</span>
                        <span className={muted}>(none)</span>
                      </button>
                      {allMilestones.map((m) => {
                        const checked = issue.milestone?.id === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            data-testid={`milestone-set-${m.id}`}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await api.setIssueMilestone(workspaceSlug, number, m.id);
                                setMilestoneMenuOpen(false);
                                await refresh();
                              } finally {
                                setBusy(false);
                              }
                            }}
                            className="flex items-center gap-2 w-full px-2 py-1 text-xs hover:bg-[var(--cf-hover)] rounded"
                          >
                            <span aria-hidden>{checked ? "✓" : " "}</span>
                            <span>{m.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canPin && <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid="issue-pin-toggle"
            title={isPinned ? "Unpin" : "Pin to top"}
            onClick={async () => {
              setBusy(true);
              try {
                if (isPinned) await api.unpinIssue(workspaceSlug, number);
                else await api.pinIssue(workspaceSlug, number);
                await onPinChanged?.();
              } finally {
                setBusy(false);
              }
            }}
          >
            {isPinned ? "📌 Pinned" : "📌 Pin"}
          </Button>}
          <Button variant="outline" size="sm" onClick={toggleState} disabled={busy} data-testid="issue-toggle-state">
            {issue.state === "open" ? "Close issue" : "Reopen"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="issue-exit">
            Close view
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-4">
        <div className="rounded border border-[var(--cf-border)] p-3">
          <div className={cn("text-xs mb-2", muted)}>
            <strong className="text-[var(--cf-fg)]">@{issue.author}</strong> opened this issue
          </div>
          <div className="text-sm">
            {issue.body ? (
              <IssueBodyRender
                text={issue.body}
                ctx={documentContext}
                onOpenPageById={onOpenPageById}
                onOpenPath={onOpenPath}
                onOpenNumber={(n) => {
                  if (n !== number) onOpenNumber?.(n);
                }}
              />
            ) : (
              <em className={muted}>(no description)</em>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
            <DependencySection
              testIdPrefix="depends-on"
              title="Depends on"
              items={dependencies}
              showAdd={true}
              addValue={addDepNum}
              setAddValue={setAddDepNum}
              onAdd={async () => {
                const n = Number(addDepNum);
                if (!Number.isFinite(n) || n <= 0 || n === number) return;
                setBusy(true);
                try {
                  await api.addIssueDependency(workspaceSlug, number, n);
                  setAddDepNum("");
                  await refresh();
                } finally {
                  setBusy(false);
                }
              }}
              onRemove={async (n) => {
                setBusy(true);
                try {
                  await api.removeIssueDependency(workspaceSlug, number, n);
                  await refresh();
                } finally {
                  setBusy(false);
                }
              }}
              onOpen={onOpenNumber}
              busy={busy}
            />
            <DependencySection
              testIdPrefix="blocked-by"
              title="Blocks"
              items={blocks}
              showAdd={false}
              onOpen={onOpenNumber}
              busy={busy}
            />
        </div>
        {mergeTimeline(comments, timeline).map((item) => {
          if (item.kind === "event") {
            return <TimelineRow key={`event-${item.e.id}`} e={item.e} onOpenNumber={onOpenNumber} />;
          }
          const c = item.c;
          const isOwn = !!currentForgejoUsername && c.author === currentForgejoUsername;
          const editing = editingId === c.id;
          return (
            <div
              key={c.id}
              className="rounded border border-[var(--cf-border)] p-3"
              data-testid={`issue-comment-${c.id}`}
            >
              <div className={cn("flex items-center gap-2 text-xs mb-2", muted)}>
                <strong className="text-[var(--cf-fg)]">@{c.author}</strong>
                <span>{formatRel(c.created_at)}</span>
                {c.updated_at > c.created_at + 1000 && <span>(edited)</span>}
                {isOwn && !editing && (
                  <span className="ml-auto flex gap-2">
                    <button
                      type="button"
                      data-testid={`issue-comment-edit-${c.id}`}
                      onClick={() => { setEditingId(c.id); setEditDraft(c.body); }}
                      className="hover:underline"
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      data-testid={`issue-comment-delete-${c.id}`}
                      onClick={async () => {
                        if (!window.confirm("Delete this comment?")) return;
                        await api.deleteIssueComment(workspaceSlug, number, c.id);
                        await refresh();
                      }}
                      className="hover:underline text-red-600"
                    >
                      delete
                    </button>
                  </span>
                )}
              </div>
              {editing ? (
                <div className="flex flex-col gap-1">
                  <FocusedTextarea
                    value={editDraft}
                    onChange={setEditDraft}
                    rows={3}
                    className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button
                      size="sm"
                      data-testid={`issue-comment-save-${c.id}`}
                      disabled={busy || editDraft.trim().length === 0 || editDraft === c.body}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api.editIssueComment(workspaceSlug, number, c.id, editDraft.trim());
                          setEditingId(null);
                          await refresh();
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm">
                  <IssueBodyRender
                    text={c.body}
                    ctx={documentContext}
                    onOpenPageById={onOpenPageById}
                    onOpenPath={onOpenPath}
                    onOpenNumber={onOpenNumber}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-[var(--cf-border)] p-3 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={3}
          data-testid="issue-new-comment"
          className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            data-testid="issue-new-comment-submit"
            disabled={busy || draft.trim().length === 0}
            onClick={submitComment}
          >
            Comment
          </Button>
        </div>
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </div>
  );
}

function DependencySection({
  testIdPrefix,
  title,
  items,
  showAdd,
  addValue,
  setAddValue,
  onAdd,
  onRemove,
  onOpen,
  busy,
}: {
  testIdPrefix: string;
  title: string;
  items: readonly DependencyRow[];
  showAdd: boolean;
  addValue?: string;
  setAddValue?: (v: string) => void;
  onAdd?: () => void | Promise<void>;
  onRemove?: (n: number) => void | Promise<void>;
  onOpen?: (n: number) => void;
  busy: boolean;
}): ReactElement {
  return (
    <div
      data-testid={`${testIdPrefix}-section`}
      className="rounded border border-[var(--cf-border)] p-2 flex flex-col gap-1"
    >
      <div className={cn("text-xs uppercase tracking-wide", muted)}>{title}</div>
      {items.length === 0 ? (
        <div className={cn("text-xs", muted)}>—</div>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
          {items.map((it) => (
            <li
              key={`${testIdPrefix}-${it.number}`}
              data-testid={`${testIdPrefix}-${it.number}`}
              className="flex items-baseline gap-1 text-xs"
            >
              <span aria-hidden>{it.state === "closed" ? "●" : "○"}</span>
              <button
                type="button"
                className="text-[var(--cf-accent)] hover:underline"
                onClick={() => onOpen?.(it.number)}
              >
                #{it.number}
              </button>
              <span className="truncate">{it.title}</span>
              {onRemove && (
                <button
                  type="button"
                  data-testid={`${testIdPrefix}-${it.number}-remove`}
                  onClick={() => onRemove(it.number)}
                  disabled={busy}
                  className="ml-auto text-red-600 hover:underline"
                  title="Remove dependency"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showAdd && setAddValue && onAdd && (
        <div className="flex items-center gap-1 mt-1">
          <input
            type="text"
            inputMode="numeric"
            value={addValue ?? ""}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="# of issue"
            data-testid={`${testIdPrefix}-add-input`}
            className="w-20 text-xs rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-1 py-0.5"
          />
          <button
            type="button"
            disabled={busy || !addValue?.trim()}
            data-testid={`${testIdPrefix}-add`}
            onClick={() => void onAdd()}
            className="text-xs hover:underline"
          >
            + add
          </button>
        </div>
      )}
    </div>
  );
}

type MergedItem =
  | { kind: "comment"; c: IssueComment; ts: number }
  | { kind: "event"; e: TimelineEvent; ts: number };

function mergeTimeline(
  comments: readonly IssueComment[],
  timeline: readonly TimelineEvent[],
): MergedItem[] {
  // Forgejo's timeline includes "comment" events that duplicate the items
  // we already fetched from /comments (with edit/delete affordances). Use
  // the latter for comments; pull non-comment events from the timeline.
  const items: MergedItem[] = [];
  for (const c of comments) items.push({ kind: "comment", c, ts: c.created_at });
  for (const e of timeline) {
    if (e.type === "comment") continue;
    items.push({ kind: "event", e, ts: e.created_at });
  }
  items.sort((a, b) => a.ts - b.ts);
  return items;
}

function TimelineRow({
  e,
  onOpenNumber,
}: {
  e: TimelineEvent;
  onOpenNumber?: (n: number) => void;
}): ReactElement | null {
  const desc = describeEvent(e);
  if (!desc) return null;
  return (
    <div
      data-testid={`timeline-${e.type}-${e.id}`}
      className={cn("flex items-center gap-2 text-xs px-2 py-1 border-l-2 border-[var(--cf-border)]", muted)}
    >
      <span aria-hidden>{desc.icon}</span>
      {e.author && <strong className="text-[var(--cf-fg)]">@{e.author}</strong>}
      <span>{desc.text(onOpenNumber)}</span>
      <span className="ml-auto">{formatRel(e.created_at)}</span>
    </div>
  );
}

function describeEvent(e: TimelineEvent): { icon: string; text: (jump?: (n: number) => void) => ReactElement } | null {
  switch (e.type) {
    case "close":
      return { icon: "●", text: () => <span>closed this</span> };
    case "reopen":
      return { icon: "○", text: () => <span>reopened this</span> };
    case "label":
      return e.label
        ? {
            icon: "🏷",
            text: () => (
              <>
                added the{" "}
                <span
                  className="px-1 rounded"
                  style={{ backgroundColor: `#${e.label?.color}33`, color: `#${e.label?.color}` }}
                >
                  {e.label?.name}
                </span>{" "}
                label
              </>
            ),
          }
        : null;
    case "unlabel":
      return e.label
        ? { icon: "🏷", text: () => <>removed the {e.label?.name} label</> }
        : null;
    case "assignees":
      return e.assignee
        ? {
            icon: "👤",
            text: () => <>{e.removed_assignee ? "unassigned" : "assigned"} @{e.assignee}</>,
          }
        : null;
    case "change_title":
      return {
        icon: "✎",
        text: () => <>renamed from "{e.old_title}" to "{e.new_title}"</>,
      };
    case "milestone":
      return e.milestone ? { icon: "🎯", text: () => <>added to milestone "{e.milestone}"</> } : null;
    case "demilestone":
      return e.milestone ? { icon: "🎯", text: () => <>removed from milestone "{e.milestone}"</> } : null;
    case "commit_ref":
      return e.ref_commit_sha
        ? { icon: "✦", text: () => <>referenced this in commit {e.ref_commit_sha?.slice(0, 7)}</> }
        : null;
    case "issue_ref":
    case "comment_ref":
      return e.ref_issue
        ? {
            icon: "↩",
            text: (jump) => (
              <>
                referenced this in{" "}
                <button
                  type="button"
                  className="text-[var(--cf-accent)] hover:underline"
                  onClick={() => e.ref_issue && jump?.(e.ref_issue)}
                >
                  #{e.ref_issue}
                </button>
              </>
            ),
          }
        : null;
    case "dependency_added":
      return e.dependent_issue
        ? {
            icon: "⛓",
            text: (jump) => (
              <>
                added dependency{" "}
                <button
                  type="button"
                  className="text-[var(--cf-accent)] hover:underline"
                  onClick={() => e.dependent_issue && jump?.(e.dependent_issue.number)}
                >
                  #{e.dependent_issue?.number}
                </button>
              </>
            ),
          }
        : null;
    case "dependency_removed":
      return e.dependent_issue
        ? {
            icon: "⛓",
            text: () => <>removed dependency #{e.dependent_issue?.number}</>,
          }
        : null;
    case "pin":
      return { icon: "📌", text: () => <>pinned this</> };
    case "unpin":
      return { icon: "📌", text: () => <>unpinned this</> };
    default:
      return null;
  }
}

function FocusedTextarea({
  value,
  onChange,
  rows,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
  className: string;
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      className={className}
    />
  );
}

function formatRel(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
