// Shared query-string parsers used by both the typed API routes and the
// server-rendered web routes.

export type ListState = "open" | "closed" | "all";

export async function readJsonBody(req: { json(): Promise<unknown> }, fallback: unknown = null): Promise<unknown> {
  return req.json().catch(() => fallback);
}

export async function readJsonObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const raw = await readJsonBody(req, {});
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function parseListState(value: string | undefined): ListState {
  return value === "closed" || value === "all" ? value : "open";
}

export function parsePositiveInt(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function parseBoundedPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Math.max(1, Math.min(max, parsed));
}

// Positive-integer id parser over `unknown`: handles both path params (strings)
// and JSON body fields (already numbers). Returns null when not a positive int.
// The string-only `parsePositiveInt` stays for query-param callers that want
// `undefined`.
export function parsePositiveIntId(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The {title?, body?} edit body shared by PATCH issue and PATCH pull: title is
// required + trimmed when present, body must be a string (passed through
// untrimmed), and at least one must be present. Returns a discriminated result
// so each route keeps its own error envelope and forge call.
export function parseTitleBodyPatch(
  raw: unknown,
): { ok: true; patch: { title?: string; body?: string } } | { ok: false; message: string } {
  const body = raw as { title?: unknown; body?: unknown } | null;
  const patch: { title?: string; body?: string } = {};
  if (body?.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) return { ok: false, message: "title required" };
    patch.title = body.title.trim();
  }
  if (body?.body !== undefined) {
    if (typeof body.body !== "string") return { ok: false, message: "body must be a string" };
    patch.body = body.body;
  }
  if (patch.title === undefined && patch.body === undefined) return { ok: false, message: "title or body required" };
  return { ok: true, patch };
}

// A non-empty comment body from a JSON request payload — pins the one
// "comment body required" spelling shared by issue/PR comment post + edit.
export function requireCommentBody(raw: unknown): { ok: true; text: string } | { ok: false; message: string } {
  const body = raw as { body?: unknown } | null;
  const text = typeof body?.body === "string" ? body.body : "";
  if (!text.trim()) return { ok: false, message: "comment body required" };
  return { ok: true, text };
}

export function parsePositiveIntList(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (!parts.every((part) => /^\d+$/.test(part))) return undefined;
  const ids = parts.map((part) => Number(part));
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) return undefined;
  return ids.length > 0 ? ids : undefined;
}
