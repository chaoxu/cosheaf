// Initials avatar chips, shared by thread rendering and the sidebar identity
// block. Cosheaf renders an initials chip (not the Forgejo avatar URL) so the
// backing forge stays hidden. Kept in its own low-level module so the chrome
// (web-shell/web-page) and the higher-level thread code can both import it
// without an import cycle.
import { createHash } from "node:crypto";
import { DELETED_USER_LOGIN, type ForgejoUser } from "../forgejo-types.js";
import { html, type Html } from "./web-html.js";

// Whether the user has uploaded a custom avatar, vs Forgejo's generated
// identicon (whose avatar_url hash is md5(lowercase(email))). Cosheaf renders
// initials by default and shows only a real upload, served through the
// /account/avatar proxy so the backing forge stays hidden (#150).
export function hasCustomAvatar(user: Pick<ForgejoUser, "avatar_url" | "email">): boolean {
  if (!user.avatar_url || !user.email) return false;
  const hash = user.avatar_url.split("?")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const identicon = createHash("md5").update(user.email.trim().toLowerCase()).digest("hex");
  return hash.length > 0 && hash !== identicon;
}

// A real (uploaded) avatar image styled to match the initials chip. `src` is a
// cosheaf proxy URL, never the Forgejo avatar URL.
export function avatarImg(login: string | null | undefined, src: string): Html {
  const name = login || DELETED_USER_LOGIN;
  return html`<img class="avatar-chip avatar-chip-img" src="${src}" alt="${name}" title="${name}">`;
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
  // role=img + aria-label so each chip announces the participant to a screen
  // reader (the visible title stays for mouse hover).
  const name = login || DELETED_USER_LOGIN;
  return html`<span class="avatar-chip avatar-chip--${tint(login)}" role="img" aria-label="${name}" title="${name}">${initials(login)}</span>`;
}
