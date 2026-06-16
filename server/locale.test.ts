import { describe, expect, it } from "vitest";
import { negotiateAcceptLanguage } from "./locale.js";

describe("negotiateAcceptLanguage", () => {
  it("returns null without a header", () => {
    expect(negotiateAcceptLanguage(undefined)).toBeNull();
    expect(negotiateAcceptLanguage("")).toBeNull();
  });

  it("picks a supported locale by exact tag", () => {
    expect(negotiateAcceptLanguage("zh")).toBe("zh");
    expect(negotiateAcceptLanguage("en")).toBe("en");
  });

  it("matches by primary subtag (zh-CN -> zh)", () => {
    expect(negotiateAcceptLanguage("zh-CN")).toBe("zh");
    expect(negotiateAcceptLanguage("en-US")).toBe("en");
  });

  it("honors q-value ordering, not list order", () => {
    expect(negotiateAcceptLanguage("en;q=0.6, zh;q=0.9")).toBe("zh");
    expect(negotiateAcceptLanguage("zh;q=0.2, en;q=0.8")).toBe("en");
  });

  it("skips unsupported tags and zero-weight tags", () => {
    expect(negotiateAcceptLanguage("fr, de, zh")).toBe("zh");
    expect(negotiateAcceptLanguage("zh;q=0, en")).toBe("en");
  });

  it("returns null when nothing is supported", () => {
    expect(negotiateAcceptLanguage("fr-FR, de;q=0.8")).toBeNull();
  });
});
