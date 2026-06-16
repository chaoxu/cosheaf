// Hand-rolled i18n for cosheaf's UI chrome. Deliberately tiny: a key->string
// lookup over plain TS catalogs with {var} interpolation — no dependency, no
// build step. The hono/html template auto-escapes interpolated strings, so a
// plain-string t() is XSS-safe; CLDR plurals/dates use the platform Intl.*
// built-ins, wired per-namespace as those surfaces are extracted.
//
// Locale flows EXPLICITLY (no AsyncLocalStorage): middleware sets `locale`/`t`
// on the request context, handlers read them and pass `t` down to renderers, so
// every renderer stays pure and testable. Islands import this module too (it
// must stay free of any server-only import) and call translate(key, locale)
// with the locale from the <body data-cosheaf-locale> attribute.
//
// REVISIT TRIGGER: if this grows to many locales, RTL, an external translator /
// TMS handoff, or a large ICU-plural surface, migrate to Paraglide JS
// (@inlang/paraglide-js) — it maps 1:1 onto this design but adds a Vite compile
// step + inlang JSON we don't need at two-LTR-locale scale.
import { en } from "./en.js";
import { zh } from "./zh.js";

export const SUPPORTED_LOCALES = ["en", "zh"] as const;
export type LocaleId = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: LocaleId = "en";

export function isLocaleId(value: string): value is LocaleId {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// Match a locale tag to a supported locale: exact, then primary subtag
// (zh-CN -> zh), else null. The shared primitive behind normalizeLocale and the
// server's Accept-Language negotiator, so the subtag fold lives in one place.
export function matchSupported(tag: string): LocaleId | null {
  const lower = tag.toLowerCase();
  if (isLocaleId(lower)) return lower;
  const primary = lower.split("-")[0];
  return isLocaleId(primary) ? primary : null;
}

// Map an arbitrary locale tag onto a supported locale, else the default.
export function normalizeLocale(value: string | null | undefined): LocaleId {
  return value ? (matchSupported(value) ?? DEFAULT_LOCALE) : DEFAULT_LOCALE;
}

// Writing direction. No RTL locale is supported yet; computing it here means
// adding ar/he/fa later is one edit and pageShell already renders <html dir>.
const RTL_LOCALES = new Set<string>(["ar", "he", "fa", "ur"]);
export function localeDir(locale: LocaleId): "ltr" | "rtl" {
  return RTL_LOCALES.has(locale) ? "rtl" : "ltr";
}

export type MessageKey = keyof typeof en;

// en is the full source; other locales are Partial and fall back to en, then to
// the key itself. The `satisfies` makes a key absent from en (a typo in any
// non-en catalog) a compile error, without requiring full translation coverage.
const CATALOGS = { en, zh } satisfies Record<LocaleId, Partial<Record<MessageKey, string>>>;

export function translate(key: MessageKey, locale: LocaleId, vars?: Record<string, string | number>): string {
  const msg = CATALOGS[locale]?.[key] ?? en[key] ?? key;
  return vars ? msg.replace(/\{(\w+)\}/g, (_m: string, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : msg;
}

// A locale-bound translate, threaded on the request context and into renderers.
export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
export function makeT(locale: LocaleId): T {
  return (key, vars) => translate(key, locale, vars);
}
