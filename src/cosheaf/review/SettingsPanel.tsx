// Workspace settings: labels and milestones management. Owner-only.

import { useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../api";
import type { Label, Milestone } from "../api";

const muted = "text-[var(--cf-muted)]";

const DEFAULT_LABEL_COLORS = ["e11d48", "f59e0b", "10b981", "3b82f6", "8b5cf6", "6b7280"];

export function SettingsPanel({ workspaceSlug }: { workspaceSlug: string }): ReactElement {
  return (
    <div className="flex flex-col gap-6 p-4 max-w-3xl">
      <h1 className="text-lg font-semibold">Workspace settings</h1>
      <LabelsManager workspaceSlug={workspaceSlug} />
      <MilestonesManager workspaceSlug={workspaceSlug} />
    </div>
  );
}

function LabelsManager({ workspaceSlug }: { workspaceSlug: string }): ReactElement {
  const [labels, setLabels] = useState<Label[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await api.listLabels(workspaceSlug);
      setLabels(r.labels);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createLabel(workspaceSlug, { name: name.trim(), color });
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="settings-labels" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Labels</h2>
      {labels.length === 0 ? (
        <div className={cn("text-sm", muted)}>No labels yet.</div>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {labels.map((l) => (
            <li key={l.id} data-testid={`settings-label-${l.id}`}>
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
                style={{ backgroundColor: `#${l.color}33`, color: `#${l.color}` }}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: `#${l.color}` }}
                  aria-hidden
                />
                {l.name}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex items-center gap-2 mt-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Label name"
          data-testid="settings-label-name"
          className="h-8 text-sm w-48"
        />
        <div className="flex items-center gap-1">
          {DEFAULT_LABEL_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`color ${c}`}
              onClick={() => setColor(c)}
              data-testid={`settings-label-color-${c}`}
              className={cn(
                "w-5 h-5 rounded-full border-2",
                color === c ? "border-[var(--cf-fg)]" : "border-transparent",
              )}
              style={{ backgroundColor: `#${c}` }}
            />
          ))}
        </div>
        <Button size="sm" type="submit" data-testid="settings-label-create" disabled={busy || !name.trim()}>
          Add label
        </Button>
      </form>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </section>
  );
}

function MilestonesManager({ workspaceSlug }: { workspaceSlug: string }): ReactElement {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await api.listMilestones(workspaceSlug, showClosed ? "all" : "open");
      setMilestones(r.milestones);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, showClosed]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMilestone(workspaceSlug, { title: title.trim(), description: description.trim() });
      setTitle("");
      setDescription("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="settings-milestones" className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Milestones</h2>
        <label className={cn("text-xs flex items-center gap-1", muted)}>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
            data-testid="settings-milestone-show-closed"
          />
          Show closed
        </label>
      </div>
      {milestones.length === 0 ? (
        <div className={cn("text-sm", muted)}>No milestones yet.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {milestones.map((m) => (
            <li
              key={m.id}
              data-testid={`settings-milestone-${m.id}`}
              className="flex items-baseline gap-2 text-sm"
            >
              <span aria-hidden>{m.state === "open" ? "🎯" : "✓"}</span>
              <strong>{m.title}</strong>
              <span className={cn("text-xs", muted)}>
                {m.open_issues} open · {m.closed_issues} closed
                {m.due_on && ` · due ${new Date(m.due_on).toLocaleDateString()}`}
              </span>
              {m.description && <span className={cn("text-xs", muted)}>— {m.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2 mt-1">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Milestone title"
          data-testid="settings-milestone-title"
          className="h-8 text-sm"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          rows={2}
          data-testid="settings-milestone-description"
          className="w-full resize-y rounded border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1 text-sm"
        />
        <div className="flex justify-end">
          <Button size="sm" type="submit" data-testid="settings-milestone-create" disabled={busy || !title.trim()}>
            Add milestone
          </Button>
        </div>
      </form>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </section>
  );
}
