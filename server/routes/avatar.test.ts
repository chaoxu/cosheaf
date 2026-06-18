import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avatarLinkForUser, forgeAvatarSrc, hasCustomAvatar, isForgeAvatarPath } from "./avatar.js";

// The default identicon's avatar_url hash is md5(lowercase(email)); a real
// upload uses a different (content-addressed) hash.
const EMAIL = "user@example.com";
const IDENTICON = createHash("md5").update(EMAIL).digest("hex");
const UPLOADED = "9aa3745aa3ee6ba378cce64bff1fbf27a7c023b577a00a01c178e290422e1b78";

describe("hasCustomAvatar", () => {
  it("is false for the generated identicon and missing fields", () => {
    expect(hasCustomAvatar({ avatar_url: `http://forge:3002/avatars/${IDENTICON}`, email: EMAIL })).toBe(false);
    expect(hasCustomAvatar({ avatar_url: "", email: EMAIL })).toBe(false);
    expect(hasCustomAvatar({ avatar_url: `http://forge:3002/avatars/${UPLOADED}` })).toBe(false);
  });
  it("is true for a real upload", () => {
    expect(hasCustomAvatar({ avatar_url: `http://forge:3002/avatars/${UPLOADED}`, email: EMAIL })).toBe(true);
  });
});

describe("forgeAvatarSrc", () => {
  it("rewrites an absolute avatar_url to the same-origin prefix", () => {
    expect(forgeAvatarSrc({ login: "u", avatar_url: `http://forge:3002/avatars/${UPLOADED}`, email: EMAIL })).toBe(
      `/forge-avatars/avatars/${UPLOADED}`,
    );
  });
  it("handles a root-relative avatar_url without throwing", () => {
    expect(forgeAvatarSrc({ login: "u", avatar_url: `/avatars/${UPLOADED}`, email: EMAIL })).toBe(
      `/forge-avatars/avatars/${UPLOADED}`,
    );
  });
  it("preserves a query string", () => {
    expect(forgeAvatarSrc({ login: "u", avatar_url: `http://forge/avatars/${UPLOADED}?size=84`, email: EMAIL })).toBe(
      `/forge-avatars/avatars/${UPLOADED}?size=84`,
    );
  });
  it("returns null for identicon, missing user, and malformed url", () => {
    expect(forgeAvatarSrc(null)).toBeNull();
    expect(forgeAvatarSrc({ login: "u", avatar_url: `http://forge/avatars/${IDENTICON}`, email: EMAIL })).toBeNull();
    expect(forgeAvatarSrc({ login: "u", avatar_url: "http://[::::]/bad", email: EMAIL })).toBeNull();
  });
});

describe("isForgeAvatarPath", () => {
  it("accepts a content-addressed avatar segment", () => {
    expect(isForgeAvatarPath(`avatars/${UPLOADED}`)).toBe(true);
    expect(isForgeAvatarPath("repo-avatars/abc123_DEF")).toBe(true);
  });
  it("rejects traversal, extra segments, other prefixes, and host changes", () => {
    for (const bad of ["avatars/..", "avatars/.", "avatars/../config", "avatars/a/b", "config", "user/login", "avatars/", "avatars/a b"]) {
      expect(isForgeAvatarPath(bad)).toBe(false);
    }
  });
});

describe("avatarLinkForUser", () => {
  it("links a valid user avatar to that user's profile", () => {
    const body = String(avatarLinkForUser({ login: "alice", avatar_url: "", email: EMAIL }));
    expect(body).toContain('class="avatar-link"');
    expect(body).toContain('href="/users/alice"');
    expect(body).toContain('aria-label="alice profile"');
  });

  it("does not link missing or deleted users", () => {
    expect(String(avatarLinkForUser(null))).not.toContain('class="avatar-link"');
    expect(String(avatarLinkForUser({ login: "(deleted)", avatar_url: "", email: EMAIL }))).not.toContain('class="avatar-link"');
  });
});
