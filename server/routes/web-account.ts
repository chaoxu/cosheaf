import { type Context, type Hono } from "hono";
import type { T } from "../../shared/i18n/index.js";
import { mintApiToken } from "../api-tokens.js";
import type { ForgejoSshKey, ForgejoUser } from "../forgejo-types.js";
import type { AppEnv } from "../types.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { avatarForUser, forgeAvatarSrc, hasCustomAvatar } from "./avatar.js";
import { DYNAMIC_HTML_CACHE_CONTROL, globalRoute, invalidateCurrentUserAvatar, positiveInt, redirect, setAuthCookie, stringField, textField } from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { addDisclosure, userPreferencesSection, userProfileSection } from "./web-page.js";
import { globalSidebar, pageShell } from "./web-shell.js";

type GlobalWebAuth = Parameters<Parameters<typeof globalRoute>[0]>[1];

interface AccountSettingsOptions {
  apiToken?: string;
  apiTokenError?: string;
}

async function accountSettingsResponse(c: Context<AppEnv>, auth: GlobalWebAuth, opts: AccountSettingsOptions = {}): Promise<Response> {
  const [me, sshKeys] = await Promise.all([
    c.get("fjUser").getCurrentUser(),
    c.get("fjUser").listUserSshKeys(),
  ]);
  const saved = c.req.query("saved") === "1";
  const keySaved = c.req.query("ssh_key") === "1";
  const error = c.req.query("error") ?? undefined;
  const t = c.get("t");
  // This page renders via c.html (not the shared htmlResponse) so the cookies
  // the handler sets on the context survive; stamp the same #385 header here.
  c.header("cache-control", DYNAMIC_HTML_CACHE_CONTROL);
  return c.html(
    pageShell({
      title: t("settings.account_settings"),
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("account", auth.user.username, forgeAvatarSrc(me), t),
      statusPath: [{ label: t("nav.account") }],
      body: html`
        <main class="page">
          <div class="settings-page account-settings">
            <div class="page-title compact">
              <div>
                <h1>${t("settings.title")}</h1>
              </div>
            </div>
            ${userProfileSection(me, { saved, error })}
            ${avatarSection(me)}
            ${accountApiTokenSection(opts)}
            ${accountSshKeysSection(sshKeys, keySaved)}
            ${userPreferencesSection(auth.user.username, c.get("locale"), t)}
            ${accountSignOutSection(t)}
          </div>
        </main>
      `,
    }),
  );
}

const SSH_KEY_TYPES = new Set(["ssh-rsa", "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"]);

function normalizeSshPublicKey(raw: string): string | null {
  const key = raw.trim().replace(/\s+/g, " ");
  const [type, body] = key.split(" ");
  if (!type || !body || !SSH_KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(body)) return null;
  return key;
}

function defaultSshKeyTitle(key: string): string {
  const comment = key.split(" ").slice(2).join(" ").trim();
  return comment || "Cosheaf SSH key";
}

function accountApiTokenSection(opts: AccountSettingsOptions): Html {
  return html`<section class="settings-section" data-testid="settings-api-token">
    <div class="settings-section-header">
      <h2>Agent access</h2>
      <p>Use a Cosheaf API token with agents and command-line tools.</p>
    </div>
    <div class="settings-form">
      <form method="post" action="/account/api-token" data-testid="api-token-form">
        <label class="settings-row">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required data-testid="api-token-password">
        </label>
        <div class="settings-actions">
          <button class="button" type="submit" data-testid="api-token-reveal">Reveal token</button>
          ${opts.apiTokenError ? html`<p class="muted" role="alert" data-testid="api-token-error">${opts.apiTokenError}</p>` : emptyHtml}
        </div>
      </form>
      ${
        opts.apiToken
          ? html`<div class="settings-note api-token-result" data-testid="api-token-result">
              <label class="settings-row">
                <span>Token</span>
                <input readonly spellcheck="false" value="${opts.apiToken}" data-testid="api-token-value" onclick="this.select()">
              </label>
              <div class="settings-actions">
                <button class="button" type="button" data-testid="api-token-copy" onclick="navigator.clipboard?.writeText(this.closest('[data-testid=api-token-result]')?.querySelector('[data-testid=api-token-value]')?.value ?? '')">Copy token</button>
              </div>
              <p>Send it as <code>Authorization: Bearer &lt;token&gt;</code>, or as <code>Authorization: token &lt;token&gt;</code> for tea-compatible clients. Treat it like your password.</p>
            </div>`
          : html`<div class="settings-note">
              <p>The token acts as you and can read or write repositories you can access.</p>
            </div>`
      }
    </div>
  </section>`;
}

function accountSshKeysSection(keys: ForgejoSshKey[], saved: boolean): Html {
  return html`<section class="settings-section" data-testid="settings-ssh-keys">
    <div class="settings-section-header">
      <h2>SSH keys</h2>
      <p>Use SSH keys for git clone and push without a Cosheaf password.</p>
    </div>
    <div class="settings-form">
      ${
        keys.length === 0
          ? html`<p class="muted" data-testid="ssh-keys-empty">No SSH keys yet.</p>`
          : html`<div class="ssh-key-list" data-testid="ssh-key-list">${keys.map((key) => html`
              <div class="ssh-key-row" data-testid="ssh-key-row">
                <div class="ssh-key-main">
                  <strong>${key.title}</strong>
                  ${key.fingerprint ? html`<code>${key.fingerprint}</code>` : emptyHtml}
                </div>
                <form method="post" action="/account/ssh-keys/delete" data-testid="ssh-key-delete-form">
                  <input type="hidden" name="id" value="${key.id}">
                  <button class="button" type="submit">Delete</button>
                </form>
              </div>
            `)}</div>`
      }
      ${addDisclosure("Add SSH key", html`<form class="ssh-key-add-form" method="post" action="/account/ssh-keys" data-testid="ssh-key-form">
        <label class="settings-row">
          <span>Title</span>
          <input name="title" autocomplete="off" placeholder="Laptop">
        </label>
        <label class="settings-row settings-row--textarea">
          <span>Public key</span>
          <textarea name="key" rows="3" spellcheck="false" required placeholder="ssh-ed25519 AAAA..." data-testid="ssh-key-input"></textarea>
        </label>
        <div class="settings-actions">
          <button class="button primary" type="submit" data-testid="ssh-key-submit">Add SSH key</button>
          ${saved ? html`<p class="muted" data-testid="ssh-key-saved">Saved.</p>` : emptyHtml}
        </div>
      </form>`)}
      <div class="settings-note">
        <p>SSH clone uses your private key locally. Cosheaf stores only the public key in Forgejo.</p>
      </div>
    </div>
  </section>`;
}

// Sign-out lives on the Account page (#127) instead of an always-present
// status-bar button. A plain POST form to /logout — no island needed.
function accountSignOutSection(t: T): Html {
  return html`<section class="settings-section" data-testid="account-signout">
    <div class="settings-section-header">
      <h2>${t("settings.session")}</h2>
      <p>${t("settings.sign_out_desc")}</p>
    </div>
    <form class="settings-form" method="post" action="/logout">
      <div class="settings-actions">
        <button class="button" type="submit" data-testid="signout">${t("auth.sign_out")}</button>
      </div>
    </form>
  </section>`;
}

// Profile-picture section (#150): initials by default, opt-in uploaded avatar.
// The preview renders the same server-rendered <img> the chrome does — a
// same-origin /forge-avatars/* URL, never the Forgejo avatar URL (#177).
function avatarSection(me: ForgejoUser): Html {
  const custom = hasCustomAvatar(me);
  return html`<section class="settings-section" data-testid="settings-avatar">
    <div class="settings-section-header">
      <h2>Profile picture</h2>
      <p>Cosheaf shows your initials by default. Upload a picture to use it instead.</p>
    </div>
    <div class="settings-form">
      <div class="avatar-edit">
        <span class="avatar-preview" data-testid="avatar-preview">
          ${avatarForUser(me)}
        </span>
        <div class="avatar-controls">
          <form method="post" action="/account/avatar" enctype="multipart/form-data" class="avatar-upload-form" data-testid="avatar-upload-form">
            <input type="file" name="avatar" accept="image/png,image/jpeg,image/gif,image/webp" required data-testid="avatar-file">
            <button class="button primary" type="submit" data-testid="avatar-upload">Upload</button>
          </form>
          ${custom ? html`<form method="post" action="/account/avatar/remove" data-testid="avatar-remove-form"><button class="button" type="submit" data-testid="avatar-remove">Remove</button></form>` : emptyHtml}
        </div>
      </div>
    </div>
  </section>`;
}

const settingsError = (msg: string): Response => redirect(`/account/settings?error=${encodeURIComponent(msg)}`);
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AVATAR_MAX_BYTES = 1_000_000;
const AVATAR_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function registerAccountRoutes(web: Hono<AppEnv>): void {
  web.get("/account/settings", globalRoute((c, auth) => accountSettingsResponse(c, auth)));

  web.post("/account/api-token", globalRoute(async (c, auth) => {
    const form = await c.req.parseBody();
    const password = stringField(form.password);
    if (!password) return accountSettingsResponse(c, auth, { apiTokenError: "Enter your password to reveal an API token." });
    const outcome = await exchangeForgejoCredsForPat(
      c.get("db"),
      c.get("config").forgejoUrl,
      auth.user.username,
      password,
    );
    if (outcome.kind === "bad_credentials") {
      return accountSettingsResponse(c, auth, { apiTokenError: "Password did not match this account." });
    }
    if (outcome.kind === "upstream_unavailable") {
      return accountSettingsResponse(c, auth, { apiTokenError: `Could not create an API token: ${outcome.detail}` });
    }
    // The revealed API token must be the opaque Cosheaf token (usable as Bearer),
    // not the raw backend PAT.
    const apiToken = mintApiToken(c.get("db"), auth.user.username, outcome.pat);
    setAuthCookie(c, apiToken);
    return accountSettingsResponse(c, auth, { apiToken });
  }));

  web.post("/account/avatar", globalRoute(async (c, auth) => {
    const contentLength = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > AVATAR_MAX_BYTES + AVATAR_MULTIPART_OVERHEAD_BYTES) {
      return settingsError("Profile picture must be under 1 MB.");
    }
    let body: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      body = await c.req.parseBody();
    } catch (_err) {
      return settingsError("Could not read profile picture upload.");
    }
    const file = body.avatar;
    if (!(file instanceof File) || file.size === 0) return settingsError("Choose an image to upload.");
    if (!ALLOWED_AVATAR_TYPES.has(file.type)) return settingsError("Profile picture must be PNG, JPEG, GIF, or WebP.");
    if (file.size > AVATAR_MAX_BYTES) return settingsError("Profile picture must be under 1 MB.");
    const image = Buffer.from(await file.arrayBuffer()).toString("base64");
    try {
      await c.get("fjUser").setUserAvatar(image);
    } catch (err) {
      return settingsError(`Could not set profile picture: ${(err as Error).message}`);
    }
    invalidateCurrentUserAvatar(auth.forgejoToken);
    return redirect("/account/settings?saved=1");
  }));

  web.post("/account/avatar/remove", globalRoute(async (c, auth) => {
    try {
      await c.get("fjUser").deleteUserAvatar();
    } catch (err) {
      return settingsError(`Could not remove profile picture: ${(err as Error).message}`);
    }
    invalidateCurrentUserAvatar(auth.forgejoToken);
    return redirect("/account/settings?saved=1");
  }));

  web.post("/account/ssh-keys", globalRoute(async (c) => {
    const body = await c.req.parseBody();
    const key = normalizeSshPublicKey(textField(body.key) ?? "");
    if (!key) return settingsError("Paste a valid SSH public key.");
    const title = stringField(body.title)?.trim() ?? defaultSshKeyTitle(key);
    try {
      await c.get("fjUser").createUserSshKey({ title, key });
    } catch (err) {
      return settingsError(`Could not add SSH key: ${(err as Error).message}`);
    }
    return redirect("/account/settings?ssh_key=1");
  }));

  web.post("/account/ssh-keys/delete", globalRoute(async (c) => {
    const id = positiveInt(stringField((await c.req.parseBody()).id) ?? undefined);
    if (id === null) return settingsError("Choose an SSH key to delete.");
    try {
      await c.get("fjUser").deleteUserSshKey(id);
    } catch (err) {
      return settingsError(`Could not delete SSH key: ${(err as Error).message}`);
    }
    return redirect("/account/settings?ssh_key=1");
  }));

  web.post("/account/settings", globalRoute(async (c) => {
    const form = await c.req.parseBody();
    // Forgejo treats omitted keys as "leave unchanged" and empty strings as
    // "clear", which is exactly the form's semantics: every field is always
    // submitted, blank means cleared.
    const patch = {
      full_name: (stringField(form.full_name) ?? "").trim(),
      description: (stringField(form.description) ?? "").trim(),
      website: (stringField(form.website) ?? "").trim(),
      location: (stringField(form.location) ?? "").trim(),
    };
    try {
      await c.get("fjUser").editUserSettings(patch);
    } catch (err) {
      return settingsError(`Could not save profile: ${(err as Error).message}`);
    }
    return redirect("/account/settings?saved=1");
  }));
}
