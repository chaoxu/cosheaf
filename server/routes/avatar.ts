// Avatar chips, shared by thread rendering and the sidebar identity block.
// Cosheaf renders an initials chip by default; users with a real uploaded avatar
// get a server-rendered <img> whose src is a same-origin /forge-avatars/* URL
// (the forge host never appears in client URLs), with the initials chip beneath
// as the load-failure fallback (#177). Kept in its own low-level module so the
// chrome (web-shell/web-page) and the thread code can both import it without an
// import cycle.
import { createHash } from "node:crypto";
import { FORGEJO_NAME_RE } from "../../shared/conventions.js";
import { DELETED_USER_LOGIN, type ForgejoUser } from "../forgejo-types.js";
import { emptyHtml, html, type Html } from "./web-html.js";

// The user fields needed to render an avatar: login plus the Forgejo avatar_url
// and email used to tell a real upload from a generated identicon.
export type AvatarUser = Pick<ForgejoUser, "login" | "avatar_url" | "email">;

// Whether the user has uploaded a custom avatar, vs Forgejo's generated
// identicon (whose avatar_url hash is md5(lowercase(email))). Used only to pick
// img-vs-initials at render time (#177).
export function hasCustomAvatar(user: Pick<ForgejoUser, "avatar_url" | "email">): boolean {
  if (!user.avatar_url || !user.email) return false;
  const hash = user.avatar_url.split("?")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const identicon = createHash("md5").update(user.email.trim().toLowerCase()).digest("hex");
  return hash.length > 0 && hash !== identicon;
}

// Rewrite a Forgejo avatar_url to a same-origin /forge-avatars/* URL so the
// backing forge host never appears in a client URL (#177). Returns null when the
// user has no real upload (→ render initials). The /forge-avatars route streams
// Forgejo's content-addressed bytes and cache headers through unchanged, so the
// browser caches the image directly — no app-side proxy state, no JS swap.
export function forgeAvatarSrc(user: AvatarUser | null | undefined): string | null {
  // The trailing avatar_url check is redundant at runtime (hasCustomAvatar
  // already requires it) but narrows the type for the URL parse below.
  if (!user || !hasCustomAvatar(user) || !user.avatar_url) return null;
  let url: URL;
  try {
    // A base lets a root-relative avatar_url (Forgejo's shape is config-
    // dependent) parse too; the base host is discarded — only the path + query
    // feed the same-origin prefix. Malformed → initials fallback, never a throw.
    url = new URL(user.avatar_url, "http://forge.invalid");
  } catch (_err) {
    return null;
  }
  return `/forge-avatars${url.pathname}${url.search}`;
}

// An avatar with a precomputed same-origin src: a server-rendered <img> over the
// initials chip (the chip shows through if the image 404s or is still loading).
// `src` null → just the initials chip.
export function avatar(login: string | null | undefined, src: string | null): Html {
  if (!src) return avatarChip(login);
  return chip(login, " avatar-chip--photo", html`<img class="avatar-chip-photo" src="${src}" alt="" loading="lazy">`);
}

// The avatar-chip <span> skeleton shared by the initials chip and the photo
// variant: role=img + aria-label announce the participant to a screen reader
// (the visible title stays for mouse hover); `extraClass`/`child` carry the
// photo bits when present.
function chip(login: string | null | undefined, extraClass: string, child: Html): Html {
  const name = login || DELETED_USER_LOGIN;
  return html`<span class="avatar-chip avatar-chip--${tint(login)}${extraClass}" role="img" aria-label="${name}" title="${name}">${initials(login)}${child}</span>`;
}

// Whether a `/forge-avatars/<rest>` tail is a single content-addressed avatar
// segment safe to pass through to Forgejo (#177). The leading [A-Za-z0-9]
// rejects a dot-only `.`/`..` segment (no normalizing to the forge root), and
// the charset excludes `/ \ : @ %` so the tail can't change host or traverse.
export function isForgeAvatarPath(rest: string): boolean {
  return /^(avatars|repo-avatars)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest);
}

// Render an avatar straight from a Forgejo user object — issue/PR/comment/review
// author objects already carry avatar_url + email, so participant avatars come
// for free with no extra forge lookup (#177, folds in #174).
export function avatarForUser(user: AvatarUser | null | undefined): Html {
  return avatar(user?.login, forgeAvatarSrc(user));
}

export function avatarLinkForUser(user: AvatarUser | null | undefined): Html {
  const chipHtml = avatarForUser(user);
  const href = userProfileHref(user?.login);
  return href ? html`<a class="avatar-link" href="${href}" aria-label="${user?.login} profile">${chipHtml}</a>` : chipHtml;
}

function userProfileHref(login: string | null | undefined): string | null {
  if (!login || login === DELETED_USER_LOGIN || !FORGEJO_NAME_RE.test(login)) return null;
  return `/users/${encodeURIComponent(login)}`;
}

// First 1-2 alphanumerics of the login, for the initials avatar chip.
export function initials(login: string | null | undefined): string {
  const stripped = (login ?? "?").replace(/[^A-Za-z0-9]/g, "");
  return (stripped.slice(0, 2) || "?").toUpperCase();
}

// Deterministic 0-7 hue bucket for a login, feeding the .avatar-chip--N classes.
// Pure + stable so the same author always gets the same color across renders.
export function tint(login: string | null | undefined): number {
  const s = login ?? "?";
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum % 8;
}

export function avatarChip(login: string | null | undefined): Html {
  return chip(login, "", emptyHtml);
}
