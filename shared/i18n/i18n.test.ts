import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  isLocaleId,
  localeDir,
  makeT,
  type MessageKey,
  normalizeLocale,
  SUPPORTED_LOCALES,
  translate,
} from "./index.js";
import { en } from "./en.js";
import { zh } from "./zh.js";

describe("translate", () => {
  it("returns the locale string for a known key", () => {
    expect(translate("nav.workspaces", "en")).toBe("Workspaces");
    expect(translate("nav.workspaces", "zh")).toBe("工作区");
  });

  it("interpolates {var} placeholders", () => {
    expect(translate("home.unread", "en", { count: 3 })).toBe("3 unread");
    expect(translate("home.unread", "zh", { count: 3 })).toBe("3 条未读");
  });

  it("falls back to the key itself when a key is absent everywhere", () => {
    expect(translate("does.not.exist" as MessageKey, "en")).toBe("does.not.exist");
  });

  it("leaves an unmatched placeholder intact", () => {
    expect(translate("home.unread", "en", {})).toBe("{count} unread");
  });
});

describe("zh catalog", () => {
  it("only uses keys that exist in the en source (no orphan keys)", () => {
    const enKeys = new Set(Object.keys(en));
    for (const key of Object.keys(zh)) expect(enKeys.has(key)).toBe(true);
  });

  it("missing zh keys fall back to the English source", () => {
    // Guard the design even while zh is fully covered: any en key not in zh must
    // resolve to the English string (then the key), never to undefined.
    for (const key of Object.keys(en) as MessageKey[]) {
      const value = translate(key, "zh");
      expect(typeof value).toBe("string");
      if (!(key in zh)) expect(value).toBe(en[key]);
    }
  });
});

describe("locale helpers", () => {
  it("isLocaleId recognizes supported locales only", () => {
    expect(isLocaleId("en")).toBe(true);
    expect(isLocaleId("zh")).toBe(true);
    expect(isLocaleId("fr")).toBe(false);
  });

  it("normalizeLocale matches exact, then primary subtag, else default", () => {
    expect(normalizeLocale("zh")).toBe("zh");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("ZH-Hans")).toBe("zh");
    expect(normalizeLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(null)).toBe(DEFAULT_LOCALE);
  });

  it("localeDir is ltr for the supported locales", () => {
    for (const locale of SUPPORTED_LOCALES) expect(localeDir(locale)).toBe("ltr");
  });

  it("makeT binds a locale", () => {
    const t = makeT("zh");
    expect(t("nav.workspaces")).toBe("工作区");
    expect(t("home.unread", { count: 1 })).toBe("1 条未读");
  });
});
