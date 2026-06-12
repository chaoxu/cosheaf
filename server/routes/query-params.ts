// Shared query-string parsers used by both the typed API routes and the
// server-rendered web routes.

export type ListState = "open" | "closed" | "all";

export function parseListState(value: string | undefined): ListState {
  return value === "closed" || value === "all" ? value : "open";
}

export function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function parsePositiveIntList(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  const ids = value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}
