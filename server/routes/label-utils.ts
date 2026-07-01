import type { ForgejoLabel } from "../forgejo-types.js";
export { toLabel } from "../core/forge-dto.js";

type LabelLike = Pick<ForgejoLabel, "id" | "name"> & Partial<Pick<ForgejoLabel, "exclusive" | "is_archived">> & { scope?: string | null };

function labelScope(label: LabelLike): string | null {
  if (label.scope !== undefined) return label.scope;
  if (!label.exclusive) return null;
  const slash = label.name.lastIndexOf("/");
  return slash > 0 ? label.name.slice(0, slash) : null;
}

// Normalize a label color from user input: trim, drop a leading '#', and
// validate it's six hex digits. Returns the bare hex color, or null when
// invalid so callers can return their own error shape (JSON vs error page).
export function normalizeLabelColor(raw: string): string | null {
  const color = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

export function parsePositiveLabelIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) return null;
  return value;
}

export function validateLabelSelection(
  requestedIds: number[],
  allLabels: LabelLike[],
  currentLabels: LabelLike[],
): { ok: true } | { ok: false; message: string } {
  const byId = new Map(allLabels.map((label) => [label.id, label]));
  const currentIds = new Set(currentLabels.map((label) => label.id));
  const seenScopes = new Map<string, string>();
  for (const id of requestedIds) {
    const label = byId.get(id);
    if (!label) return { ok: false, message: `unknown label id ${id}` };
    if (label.is_archived && !currentIds.has(id)) {
      return { ok: false, message: `archived label cannot be newly assigned: ${label.name}` };
    }
    const scope = labelScope(label);
    if (scope) {
      const existing = seenScopes.get(scope);
      if (existing && existing !== label.name) {
        return { ok: false, message: `only one label in scope ${scope} can be assigned` };
      }
      seenScopes.set(scope, label.name);
    }
  }
  return { ok: true };
}
