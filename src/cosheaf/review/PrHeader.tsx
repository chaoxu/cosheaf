import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { api, type Label, type PrMeta } from "../api";
import { IssueBodyRender } from "./IssueBodyRender";
import { useWorkspaceContext } from "../workspace-context";

const muted = "text-[var(--cf-muted)]";

export function PrHeader({
  pr,
  canEdit = false,
  onUpdated,
}: {
  pr: PrMeta;
  canEdit?: boolean;
  onUpdated?: (pr: PrMeta) => void;
}): ReactElement {
  const { slug: workspaceSlug, formatId, documentContext } = useWorkspaceContext();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(pr.title);
  const [body, setBody] = useState(pr.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedReviewers, setRequestedReviewers] = useState<string[]>(pr.requested_reviewers);
  const [requestedTeams, setRequestedTeams] = useState<string[]>(pr.requested_reviewer_teams);
  const [availableReviewers, setAvailableReviewers] = useState<string[]>([]);
  const [reviewerDraft, setReviewerDraft] = useState("");
  const [labels, setLabels] = useState<Label[]>(pr.labels);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);

  useEffect(() => {
    setTitle(pr.title);
    setBody(pr.body);
    setLabels(pr.labels);
    setRequestedReviewers(pr.requested_reviewers);
    setRequestedTeams(pr.requested_reviewer_teams);
    api
      .listReviewRequests(workspaceSlug, pr.number)
      .then((r) => {
        setRequestedReviewers(r.requested_reviewers);
        setRequestedTeams(r.requested_reviewer_teams);
        setAvailableReviewers(r.available_reviewers);
      })
      .catch(() => undefined);
    api.listLabels(workspaceSlug).then((r) => setAllLabels(r.labels)).catch(() => setAllLabels([]));
  }, [workspaceSlug, pr.number, pr.title, pr.body, pr.labels, pr.requested_reviewers, pr.requested_reviewer_teams]);

  async function save() {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("title required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.updatePull(workspaceSlug, pr.number, { title: nextTitle, body });
      onUpdated?.(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  async function requestReviewer() {
    const reviewer = reviewerDraft.trim();
    if (!reviewer) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.requestPullReviewers(workspaceSlug, pr.number, [reviewer]);
      onUpdated?.(next);
      setReviewerDraft("");
      setRequestedReviewers(next.requested_reviewers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeReviewer(reviewer: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await api.removePullReviewers(workspaceSlug, pr.number, [reviewer]);
      if (next) {
        onUpdated?.(next);
        setRequestedReviewers(next.requested_reviewers);
      } else {
        setRequestedReviewers((items) => items.filter((item) => item !== reviewer));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "remove failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLabel(label: Label) {
    const has = labels.some((item) => item.id === label.id);
    if (!has && label.is_archived) return;
    const nextIds = has
      ? labels.filter((item) => item.id !== label.id).map((item) => item.id)
      : [
          ...labels
            .filter((item) => !label.exclusive || !label.scope || item.scope !== label.scope)
            .map((item) => item.id),
          label.id,
        ];
    setBusy(true);
    setError(null);
    try {
      const next = await api.setPullLabels(workspaceSlug, pr.number, nextIds);
      onUpdated?.(next);
      setLabels(next.labels);
    } catch (err) {
      setError(err instanceof Error ? err.message : "label update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header
      data-testid="pr-header"
      className="flex flex-col gap-1 px-4 py-3 border-b border-[var(--cf-border)]"
    >
      <div className="flex items-baseline gap-2">
        <Badge variant={badgeVariant(pr.state, pr.merged)}>{pr.merged ? "merged" : pr.state}</Badge>
        {editing ? (
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-base font-semibold"
            data-testid="pr-title-edit"
          />
        ) : (
          <h2 className="text-base font-semibold leading-tight flex-1 truncate" title={pr.title}>
            {pr.title}
          </h2>
        )}
        <span className={cn("text-xs", muted)} data-testid="pr-header-link">#{pr.number}</span>
        {canEdit && !editing && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="pr-edit">
            Edit
          </Button>
        )}
      </div>
      <div className={cn("flex items-center gap-3 text-xs", muted)}>
        <span>by @{pr.author_username}</span>
        <span>·</span>
        <span>
          <span className="text-green-600">+{pr.additions_total}</span>{" "}
          <span className="text-red-600">−{pr.deletions_total}</span>
          {" "}across {pr.files_changed} {pr.files_changed === 1 ? "file" : "files"}
        </span>
      </div>
      {(labels.length > 0 || canEdit) && (
        <div className="relative flex flex-wrap items-center gap-1">
          {labels.map((label) => (
            <span
              key={label.id}
              className="text-[11px] px-1.5 py-0.5 rounded"
              style={{ backgroundColor: `#${label.color}33`, color: `#${label.color}` }}
            >
              {label.name}
            </span>
          ))}
          {canEdit && (
            <div className="relative">
              <button
                type="button"
                className={cn("text-[11px] underline opacity-70", muted)}
                onClick={() => setLabelMenuOpen((value) => !value)}
              >
                + label
              </button>
              {labelMenuOpen && (
                <div className="absolute z-10 top-full mt-1 left-0 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] p-1 min-w-[180px] shadow">
                  {allLabels.length === 0 && <div className={cn("text-xs px-2 py-1", muted)}>No labels defined.</div>}
                  {allLabels.map((label) => {
                    const checked = labels.some((item) => item.id === label.id);
                    const disabled = label.is_archived && !checked;
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => void toggleLabel(label)}
                        disabled={disabled || busy}
                        title={disabled ? "Archived labels cannot be newly assigned" : label.exclusive && label.scope ? `Only one ${label.scope} label can be assigned` : undefined}
                        className="flex items-center gap-2 w-full px-2 py-1 text-xs hover:bg-[var(--cf-hover)] rounded disabled:opacity-45"
                      >
                        <span aria-hidden>{checked ? "✓" : " "}</span>
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: `#${label.color}` }}
                        />
                        <span>{label.name}</span>
                        {label.exclusive && label.scope && <span className={cn("ml-auto", muted)}>{label.scope}</span>}
                        {label.is_archived && <span className={cn("ml-auto", muted)}>archived</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {pr.milestone && (
        <div className="text-xs text-blue-700">Milestone: {pr.milestone.title}</div>
      )}
      {editing && (
        <div className="flex flex-col gap-2">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
            data-testid="pr-body-edit"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy || !title.trim()}>
              Save
            </Button>
          </div>
        </div>
      )}
      {!editing && pr.body.trim().length > 0 && (
        <div className="text-sm">
          <IssueBodyRender
            text={pr.body}
            workspaceSlug={workspaceSlug}
            formatId={formatId}
            ctx={documentContext}
            surface="document"
          />
        </div>
      )}
      <div className="flex flex-col gap-1 border-t border-[var(--cf-border)] pt-2">
        <div className={cn("text-xs uppercase tracking-wide", muted)}>Reviewers</div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {requestedReviewers.length === 0 && requestedTeams.length === 0 ? (
            <span className={muted}>No requested reviewers.</span>
          ) : (
            <>
              {requestedReviewers.map((reviewer) => (
                <span key={reviewer} className="inline-flex items-center gap-1 rounded bg-[var(--cf-hover)] px-1.5 py-0.5">
                  @{reviewer}
                  {canEdit && (
                    <button type="button" onClick={() => void removeReviewer(reviewer)} disabled={busy} aria-label={`Remove ${reviewer}`}>
                      ×
                    </button>
                  )}
                </span>
              ))}
              {requestedTeams.map((team) => (
                <span key={`team-${team}`} className="rounded bg-[var(--cf-hover)] px-1.5 py-0.5">
                  {team}
                </span>
              ))}
            </>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-1">
            <input
              list={`reviewers-${pr.number}`}
              value={reviewerDraft}
              onChange={(event) => setReviewerDraft(event.target.value)}
              placeholder="Reviewer"
              className="h-7 w-40 rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 text-xs"
              data-testid="reviewer-request-input"
            />
            <datalist id={`reviewers-${pr.number}`}>
              {availableReviewers.map((reviewer) => (
                <option key={reviewer} value={reviewer} />
              ))}
            </datalist>
            <Button size="sm" variant="outline" onClick={requestReviewer} disabled={busy || !reviewerDraft.trim()}>
              Request
            </Button>
            <span className={cn("text-xs", muted)}>CODEOWNERS requests appear here when Forgejo creates them.</span>
          </div>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    </header>
  );
}

function badgeVariant(state: PrMeta["state"], merged: boolean): "golden" | "rejected" | "outline" {
  if (merged) return "golden";
  if (state === "closed") return "rejected";
  return "outline";
}
