import { describe, expect, it } from "vitest";
import type { PrMeta } from "../../shared/review.js";
import type { WebCtx } from "./web-context.js";
import { initials, reviewForms, tint } from "./web-thread.js";

describe("initials", () => {
  it("takes the first two alphanumerics, uppercased", () => {
    expect(initials("chao")).toBe("CH");
    expect(initials("a")).toBe("A");
  });
  it("skips non-alphanumeric separators", () => {
    expect(initials("test-meri")).toBe("TE");
    expect(initials("_x9")).toBe("X9");
  });
  it("falls back to ? for empty/missing logins", () => {
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
    expect(initials("___")).toBe("?");
  });
});

describe("tint", () => {
  it("is deterministic and in [0,8)", () => {
    for (const login of ["chao", "test-meri", "test-vera", "", " alice "]) {
      const t = tint(login);
      expect(t).toBe(tint(login));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(8);
      expect(Number.isInteger(t)).toBe(true);
    }
  });
  it("handles missing logins without throwing", () => {
    expect(tint(null)).toBeGreaterThanOrEqual(0);
    expect(tint(undefined)).toBeLessThan(8);
  });
});

describe("reviewForms merge controls (#180 admin bypass)", () => {
  const render = (role: string, prAuthor: string, state = "open", user = "chao") =>
    String(
      reviewForms(
        { ws: { role }, user, owner: "chao", repo: "w" } as unknown as WebCtx,
        { number: 7, state, merged: false, author_username: prAuthor } as unknown as PrMeta,
      ),
    );

  it("shows admin merge controls and comment-only review form to the PR author", () => {
    const html = render("admin", "chao");
    expect(html).toContain("Merge PR");
    expect(html).toContain("Merge anyway");
    expect(html).toContain("review-form");
    expect(html).toContain("Comment");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Request changes");
  });

  it("shows comment-only review form to a non-admin author", () => {
    const html = render("write", "chao");
    expect(html).toContain("review-form");
    expect(html).toContain("Comment");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Request changes");
  });

  it("shows comment-only review form in read mode and hides closed PR actions", () => {
    const html = render("read", "someone-else");
    expect(html).toContain("review-form");
    expect(html).toContain("Comment");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Request changes");
    expect(render("admin", "someone-else", "closed")).toBe("");
  });
});
