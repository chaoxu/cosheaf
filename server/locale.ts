import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { DEFAULT_LOCALE, isLocaleId, type LocaleId, matchSupported } from "../shared/i18n/index.js";
import type { AppEnv } from "./types.js";

// Non-HttpOnly so the settings <select> and islands can read/write it client-side
// — the locale is a per-browser preference, not a secret (unlike cosheaf_pat).
export const LOCALE_COOKIE = "cosheaf_lang";

// Per-request locale: an explicit cookie wins (a deliberate per-browser choice,
// like the other prefs), then the browser's Accept-Language, then the default.
// Resolved once in middleware and threaded explicitly via the request context.
export function resolveLocale(c: Context<AppEnv>): LocaleId {
  const cookie = getCookie(c, LOCALE_COOKIE);
  if (cookie && isLocaleId(cookie)) return cookie;
  return negotiateAcceptLanguage(c.req.header("accept-language")) ?? DEFAULT_LOCALE;
}

// Best supported locale from an Accept-Language header, or null. Parses q-values,
// sorts by weight, and matches each tag exactly then by primary subtag
// (zh-CN -> zh) against the supported set.
export function negotiateAcceptLanguage(header: string | undefined): LocaleId | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const match = matchSupported(tag);
    if (match) return match;
  }
  return null;
}
