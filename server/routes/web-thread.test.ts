import { describe, expect, it } from "vitest";
import type { ForgejoPull } from "../forgejo.js";
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
        { number: 7, state, user: { login: prAuthor } } as unknown as ForgejoPull,
      ),
    );

  it("shows admin merge controls to the PR author (solo merge), without the review form", () => {
    const html = render("admin", "chao");
    expect(html).toContain("Merge PR");
    expect(html).toContain("Merge anyway");
    // Author can't review their own PR — no approve/request-changes form.
    expect(html).not.toContain("review-form");
  });

  it("hides everything from a non-admin author (must wait for a reviewer)", () => {
    expect(render("write", "chao")).toBe("");
  });

  it("hides everything in read mode and on a closed PR", () => {
    expect(render("read", "someone-else")).toBe("");
    expect(render("admin", "someone-else", "closed")).toBe("");
  });
});
