// PAT storage: cosheaf does not set a cookie or hold any server-side
// session. The SPA keeps the API token in localStorage and attaches
// it as `Authorization: Bearer <pat>` on every request.
const PAT_KEY = "cosheaf.pat";

export function setStoredPat(pat: string | null): void {
  if (typeof window === "undefined") return;
  if (pat === null) window.localStorage.removeItem(PAT_KEY);
  else window.localStorage.setItem(PAT_KEY, pat);
}

export function getStoredPat(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PAT_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const pat = getStoredPat();
  const base: Record<string, string> = { "content-type": "application/json" };
  if (pat) base.authorization = `Bearer ${pat}`;
  return { ...base, ...(extra ?? {}) };
}

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: authHeaders(init?.headers),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    // The backend rejected the stored token, or no token was sent. Drop the
    // local copy and bounce the page so the SPA re-mounts at the login screen.
    if (
      res.status === 401 &&
      (body.code === "pat_invalid" || body.code === "unauthorized") &&
      typeof window !== "undefined"
    ) {
      setStoredPat(null);
      window.location.reload();
    }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 304) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const workspaceApiPath = (slug: string): string => `/api/v1/w/${encodeURIComponent(slug)}`;

export function queryString(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, value);
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}
