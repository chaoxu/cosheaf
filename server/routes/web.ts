import { type Context, Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie } from "hono/cookie";
import { FORGEJO_NAME_RE, WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import type { LocaleId, MessageKey, T } from "../../shared/i18n/index.js";
import type { NotificationRow } from "../../shared/issues.js";
import { mintApiToken } from "../api-tokens.js";
import { ForgejoError } from "../forgejo.js";
import { AUTH_COOKIE } from "../middleware.js";
import { FixedWindowRateLimiter } from "../rate-limit.js";
import { effectiveRegistrationOpen, isSiteAdmin, registrationInviteForToken, releaseRegistrationInvite, reserveRegistrationInvite } from "../site-admin.js";
import type { AppEnv } from "../types.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { isForgeAvatarPath } from "./avatar.js";
import { mapThreads } from "./notifications.js";
import { registerNotificationActivityRoutes } from "./web-activity.js";
import { registerAccountRoutes } from "./web-account.js";
import { registerAdminRoutes } from "./web-admin.js";
import { registerBranchRoutes } from "./web-branches.js";
import { registerChatPageRoutes } from "./web-chat-pages.js";
import { badRequestPage, clientIp, configReposForUser, currentUserAvatarSrc, globalRoute, htmlResponse, nonNegativeInt, notFoundPage, positiveInt, redirect, rejectCrossOriginMutation, repoHref, safeWebRedirect, setAuthCookie, stringField, webRoute } from "./web-context.js";
import { registerDiagnosticsRoutes } from "./web-diagnostics.js";
import { registerFileRoutes } from "./web-files.js";
import { registerHelpRoutes } from "./web-help.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { registerIssueRoutes } from "./web-issues.js";
import { registerPullRoutes } from "./web-pulls.js";
import { registerSettingsRoutes } from "./web-settings.js";
import { globalSidebar, pageShell } from "./web-shell.js";
import { registerUserRoutes } from "./web-users.js";

export const web = new Hono<AppEnv>();
web.use("*", compress());

// Shared chrome for the sign-in / sign-up cards: the same `.auth-page` >
// `.auth-card` shell with a username + password pair; only the action, button
// label, optional notice, and the cross-link differ.
function authNotice(message: string, kind: "error" | "info"): Html {
  return html`<p class="auth-notice auth-notice--${kind}" role="alert">${message}</p>`;
}

function authPage(opts: {
  title: string;
  action: string;
  submitLabel: string;
  passwordAutocomplete: "current-password" | "new-password";
  t: T;
  locale: LocaleId;
  notice?: Html;
  altLink?: Html;
  hiddenFields?: Html;
}): Response {
  return htmlResponse(
    pageShell({
      title: opts.title,
      locale: opts.locale,
      body: html`
        <main class="auth-page">
          <form class="auth-card" method="post" action="${opts.action}">
            <h1>Cosheaf</h1>
            ${opts.notice ?? emptyHtml}
            <label>${opts.t("auth.username")} <input name="username" autocomplete="username" required></label>
            <label>${opts.t("auth.password")} <input name="password" type="password" autocomplete="${opts.passwordAutocomplete}" required></label>
            ${opts.hiddenFields ?? emptyHtml}
            <button type="submit">${opts.submitLabel}</button>
            ${opts.altLink ?? emptyHtml}
          </form>
        </main>
      `,
    }),
  );
}

// ?error= codes (and ?registered=1) map to message keys; t() renders them in the
// request locale. The whitelist keeps an arbitrary ?error= value from rendering.
const REGISTER_ERROR_KEYS: Record<string, MessageKey> = {
  missing: "err.register.missing",
  invalid: "err.register.invalid",
  taken: "err.register.taken",
  rate: "err.register.rate",
  upstream: "err.register.upstream",
  invalid_invite: "err.register.invalid_invite",
};
const LOGIN_ERROR_KEYS: Record<string, MessageKey> = {
  missing: "err.login.missing",
  invalid: "err.login.invalid",
};

// Per-IP throttle for the anonymous, admin-token-backed /register endpoint:
// 5 account creations per 10 minutes. In-process (one cosheaf process); paired
// with the same-origin check it blunts trivial signup abuse.
const registerRateLimiter = new FixedWindowRateLimiter(5, 10 * 60 * 1000);

function registerErrorLocation(error: string, inviteToken: string | null): string {
  const query = new URLSearchParams({ error });
  if (inviteToken) query.set("invite", inviteToken);
  return `/register?${query}`;
}

function requestInviteToken(c: Context<AppEnv>, formInvite?: string | null): string | null {
  const token = formInvite ?? c.req.query("invite");
  const trimmed = token?.trim();
  return trimmed || null;
}

function canShowRegister(c: Context<AppEnv>, inviteToken: string | null): boolean {
  return effectiveRegistrationOpen(c.get("db"), c.get("config")) || Boolean(registrationInviteForToken(c.get("db"), inviteToken));
}

web.get("/login", (c) => {
  const t = c.get("t");
  const open = effectiveRegistrationOpen(c.get("db"), c.get("config"));
  const error = c.req.query("error");
  const errorKey = error ? LOGIN_ERROR_KEYS[error] : undefined;
  const notice = c.req.query("registered") === "1"
    ? authNotice(t("auth.registered"), "info")
    : errorKey
      ? authNotice(t(errorKey), "error")
      : error
        ? authNotice(t("auth.login_failed"), "error")
        : undefined;
  return authPage({
    title: t("auth.sign_in"),
    action: "/login",
    submitLabel: t("auth.sign_in"),
    passwordAutocomplete: "current-password",
    t,
    locale: c.get("locale"),
    notice,
    altLink: open ? html`<p class="auth-alt">${t("auth.new_here")} <a href="/register">${t("auth.create_account_link")}</a></p>` : undefined,
  });
});

web.post("/login", async (c) => {
  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return crossOrigin;
  const form = await c.req.parseBody();
  const username = stringField(form.username);
  const password = stringField(form.password);
  if (!username || !password) return redirect("/login?error=missing");
  const outcome = await exchangeForgejoCredsForPat(
    c.get("db"),
    c.get("config").forgejoUrl,
    username,
    password,
  );
  if (outcome.kind !== "ok") return redirect("/login?error=invalid");
  setAuthCookie(c, mintApiToken(c.get("db"), outcome.username, outcome.pat));
  return c.redirect("/", 303);
});

web.post("/logout", (c) => {
  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return crossOrigin;
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.redirect("/login", 303);
});

// Self-service signup. Disabled unless COSHEAF_REGISTRATION_MODE=open
// (config.registrationOpen) or a global admin issued an invite link. Account
// creation IS a Forgejo operation: we create the Forgejo user with the
// site-admin client, then mint the same cosheaf PAT /login mints and drop the
// user straight into a session. No cosheaf users table — identity stays
// {username} from the PAT.
web.get("/register", (c) => {
  const inviteToken = requestInviteToken(c);
  if (!canShowRegister(c, inviteToken)) return c.notFound();
  const t = c.get("t");
  const error = c.req.query("error");
  const errorKey = error ? REGISTER_ERROR_KEYS[error] : undefined;
  const action = inviteToken ? `/register?invite=${encodeURIComponent(inviteToken)}` : "/register";
  return authPage({
    title: t("auth.create_account"),
    action,
    submitLabel: t("auth.create_account"),
    passwordAutocomplete: "new-password",
    t,
    locale: c.get("locale"),
    notice: error ? authNotice(errorKey ? t(errorKey) : t("err.register.failed"), "error") : undefined,
    altLink: html`<p class="auth-alt">${t("auth.have_account")} <a href="/login">${t("auth.sign_in")}</a></p>`,
    hiddenFields: inviteToken ? html`<input type="hidden" name="invite" value="${inviteToken}">` : undefined,
  });
});

web.post("/register", async (c) => {
  const config = c.get("config");
  const db = c.get("db");

  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return crossOrigin;

  const form = await c.req.parseBody();
  const inviteToken = requestInviteToken(c, stringField(form.invite));
  const registrationOpen = effectiveRegistrationOpen(db, config);
  const invite = registrationInviteForToken(db, inviteToken);
  if (!registrationOpen && !invite) return c.notFound();

  // Per-IP throttle (in-process). Counts every attempt, before validation, so a
  // flood of malformed requests can't bypass it. clientIp ignores a spoofable
  // X-Forwarded-For unless a trusted-proxy hop count is configured.
  if (!registerRateLimiter.tryAcquire(clientIp(c, config.trustedProxyHops))) {
    return redirect(registerErrorLocation("rate", inviteToken));
  }

  const username = stringField(form.username);
  const password = stringField(form.password);
  if (!username || !password) return redirect(registerErrorLocation("missing", inviteToken));
  // A name Forgejo might accept but that fails FORGEJO_NAME_RE would create an
  // account unusable as a workspace owner segment, so gate on it up front. 40 is
  // Forgejo's username cap — reject longer up front so an over-long name never
  // reaches the admin-token round-trip.
  if (username.length > 40 || !FORGEJO_NAME_RE.test(username)) return redirect(registerErrorLocation("invalid", inviteToken));

  const fjAdmin = c.get("fjAdmin");
  // Friendly duplicate check before the create (createUser otherwise throws on
  // collision). Racy, so the create still maps a 409/422 below.
  if (await fjAdmin.getUserByName(username)) return redirect(registerErrorLocation("taken", inviteToken));

  let inviteReserved = false;
  if (invite && inviteToken) {
    inviteReserved = reserveRegistrationInvite(db, inviteToken, username);
    if (!inviteReserved && !registrationOpen) return c.notFound();
  }

  try {
    // Email is synthesized (no form field, nothing stored locally) — matches
    // the CLI's `pnpm cli user add` path. Add a real email field only if/when
    // Forgejo email confirmation is turned on.
    await fjAdmin.createUser({ username, email: `${username}@cosheaf.local`, password });
  } catch (err) {
    if (inviteReserved && inviteToken) releaseRegistrationInvite(db, inviteToken, username);
    if (err instanceof ForgejoError) {
      if (err.status === 409 || (err.status === 422 && /exist|already|taken/i.test(err.bodyText))) {
        return redirect(registerErrorLocation("taken", inviteToken));
      }
      if (err.status === 400 || err.status === 422) return redirect(registerErrorLocation("invalid", inviteToken));
    }
    return redirect(registerErrorLocation("upstream", inviteToken));
  }

  // Log the new user straight in with the same PAT mint /login uses.
  const outcome = await exchangeForgejoCredsForPat(db, config.forgejoUrl, username, password);
  if (outcome.kind !== "ok") {
    // The account was created but the immediate mint couldn't complete (e.g. a
    // Forgejo signup gate). Don't fail a successful signup — send them to sign in.
    return redirect("/login?registered=1");
  }
  setAuthCookie(c, mintApiToken(c.get("db"), outcome.username, outcome.pat));
  return c.redirect("/", 303);
});

web.get("/", globalRoute(async (c, auth) => {
  const [repos, notificationResult, avatarSrc] = await Promise.all([
    configReposForUser(c),
    // Forgejo's account-level notifications are already cross-repo — the daily
    // "what needs my attention anywhere" inbox the per-repo tab can't give.
    c
      .get("fjUser")
      .listNotifications({ statusTypes: ["unread"], subjectTypes: ["Issue", "Pull"] })
      .then((threads) => ({ ok: true as const, threads }))
      .catch(() => ({ ok: false as const })),
    currentUserAvatarSrc(c.get("fjUser"), auth.forgejoToken),
  ]);
  const inbox = notificationResult.ok ? mapThreads(notificationResult.threads) : null;
  const t = c.get("t");
  const siteAdmin = isSiteAdmin(c.get("db"), auth.user.username);
  return htmlResponse(
    pageShell({
      title: t("home.title"),
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("workspaces", auth.user.username, avatarSrc, t, { siteAdmin }),
      body: html`
        <main class="page">
          <div class="page-title page-title--actions-only">
            <a class="button primary" href="/new" data-testid="new-repo">${t("home.new_repo")}</a>
          </div>
          <div id="home-inbox-slot">${inbox ? inboxSection(inbox, t) : inboxUnavailableSection()}</div>
          <div class="list">
            ${repos.length === 0
              ? html`<div class="empty">${t("home.no_repos")}</div>`
              : repos.map(
                  (repo) => html`
                  <a class="list-row repo-row" href="${repoHref(repo.owner, repo.name)}">
                    <span class="repo-row-main">
                      <strong class="ws-slug">${repo.full_name}</strong>
                      ${repo.description ? html`<span class="ws-title">${repo.description}</span>` : emptyHtml}
                    </span>
                    <small>${repo.private ? t("common.private") : t("common.public")} · ${repo.role}</small>
                  </a>
                `,
                )}
          </div>
        </main>
        <script src="/cosheaf-inbox.js" defer></script>
      `,
    }),
  );
}));

registerHelpRoutes(web);

// Cross-repo unread inbox on the home page. Each row links to the cosheaf
// issue/PR route and carries a subtle mark-read action. Rendered only when
// there are unread threads, so home stays clean when caught up.
function inboxSection(rows: readonly NotificationRow[], t: T): Html {
  if (rows.length === 0) return emptyHtml;
  return html`<section class="inbox" data-testid="home-inbox">
    <div class="inbox-head">
      <h2>${t("home.inbox")}</h2>
      <span class="inbox-count">${t("home.unread", { count: rows.length })}</span>
      <form method="post" action="/account/notifications/read-all"><button class="button small" type="submit">${t("home.mark_all_read")}</button></form>
    </div>
    <div class="list">
      ${rows.map((row) => notificationRow(row, t))}
    </div>
  </section>`;
}

function inboxUnavailableSection(): Html {
  return html`<section class="inbox" data-testid="home-inbox-unavailable">
    <div class="empty">Notifications are temporarily unavailable.</div>
  </section>`;
}

// One cross-repo notification row, shared by the home inbox and the dedicated
// account notifications page. `next` (when given) rides the mark-read POST so
// the handler returns to the page the row was acted on from.
function notificationRow(row: NotificationRow, t: T, next?: string): Html {
  return html`<div class="list-row inbox-row">
    <a class="inbox-link" href="/${row.repo}/${row.kind === "pr" ? "pulls" : "issues"}/${row.number}">
      <span class="inbox-kind ${row.kind}">${row.kind === "pr" ? "PR" : "issue"}</span>
      <strong>${row.title}</strong>
      <small>${row.repo} #${row.number}</small>
    </a>
    <form method="post" action="/account/notifications/${row.id}/read">
      ${next ? html`<input type="hidden" name="next" value="${next}">` : ""}
      <button class="button small" type="submit" title="${t("home.mark_read_title")}">${t("home.mark_read")}</button>
    </form>
  </div>`;
}

// The dedicated /account/notifications feed (#129). Unlike the home inbox it
// always renders — including a calm empty state — so the affordance is
// discoverable rather than appearing only when something is unread. Mark-read
// forms carry `next` so the POST handlers return here instead of home.
function notificationsAccountPage(rows: readonly NotificationRow[], all: boolean, t: T): Html {
  const NEXT = "/account/notifications";
  const toggle = html`<span class="state-toggles" aria-label="Filter">
    <a class="state-toggle ${all ? "" : "active"}" href="/account/notifications">${t("notif.unread")}</a> ·
    <a class="state-toggle ${all ? "active" : ""}" href="/account/notifications?state=all">${t("notif.all")}</a>
  </span>`;
  return html`<main class="page">
    <div class="page-title">
      <h1>${t("nav.notifications")}</h1>
      <div class="toolbar-actions">
        ${toggle}
        ${rows.length === 0 ? "" : html`<form method="post" action="/account/notifications/read-all"><input type="hidden" name="next" value="${NEXT}"><button class="button small" type="submit">${t("home.mark_all_read")}</button></form>`}
      </div>
    </div>
    ${
      rows.length === 0
        ? html`<div class="empty" data-testid="notifications-empty">${all ? t("notif.empty") : t("notif.caught_up")}</div>`
        : html`<div class="list" data-testid="notifications-list">
            ${rows.map((row) => notificationRow(row, t, NEXT))}
          </div>`
    }
  </main>`;
}

// Server-rendered inbox fragment the home page swaps in on a live notification
// SSE hint (#116), so the inbox HTML is never duplicated in client JS.
web.get("/account/inbox", globalRoute(async (c) => {
  const threads = await c
    .get("fjUser")
    .listNotifications({ statusTypes: ["unread"], subjectTypes: ["Issue", "Pull"] });
  return htmlResponse(String(inboxSection(mapThreads(threads), c.get("t"))));
}));

registerAdminRoutes(web);

web.post("/account/notifications/:id/read", globalRoute(async (c, auth) => {
  const id = positiveInt(c.req.param("id"));
  if (!id) return badRequestPage(auth.user.username, "Invalid notification.");
  const thread = await c.get("fjUser").getNotificationThread(id).catch(() => null);
  if (!thread) return notFoundPage(auth.user.username, "Notification not found");
  await c.get("fjUser").markNotificationRead(id);
  // Home inbox forms omit `next` and fall back to "/"; the account
  // notifications page passes its own path so it returns there.
  return redirect(safeWebRedirect(stringField((await c.req.parseBody()).next)) ?? "/");
}));

web.post("/account/notifications/read-all", globalRoute(async (c) => {
  await c.get("fjUser").markAllNotificationsRead();
  return redirect(safeWebRedirect(stringField((await c.req.parseBody()).next)) ?? "/");
}));

// Dedicated cross-repo notifications page (#129): the persistent global feed
// reachable from the sidebar on every page, including when empty. Unread by
// default; `?state=all` includes already-read threads. Mark-read reuses the
// POST handlers above (passing `next` so they return here).
web.get("/account/notifications", globalRoute(async (c, auth) => {
  const all = c.req.query("state") === "all";
  const [threads, avatarSrc] = await Promise.all([
    c
      .get("fjUser")
      .listNotifications({
        statusTypes: all ? ["unread", "read", "pinned"] : ["unread"],
        subjectTypes: ["Issue", "Pull"],
      }),
    currentUserAvatarSrc(c.get("fjUser"), auth.forgejoToken),
  ]);
  const t = c.get("t");
  return htmlResponse(
    pageShell({
      title: t("nav.notifications"),
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("notifications", auth.user.username, avatarSrc, t),
      statusPath: [{ label: t("nav.notifications") }],
      body: notificationsAccountPage(mapThreads(threads), all, t),
    }),
  );
}));

registerUserRoutes(web);

// Same-origin avatar route (#177): a transparent pass-through to Forgejo's
// content-addressed avatar paths, so cosheaf can emit <img src="/forge-avatars/…">
// for any user without leaking the forge host into client URLs. Forgejo's own
// ETag/Cache-Control flow through unchanged — the browser caches the image
// directly; there is no app-side cache and no per-user proxy. Public (avatars
// aren't sensitive) and constrained to the avatar path prefixes so it can't be
// used as an open proxy. Conditional requests are forwarded so revalidation
// returns 304s. In production this same prefix may instead be routed straight to
// Forgejo by the edge reverse proxy; cosheaf serving it keeps dev self-contained.
web.get("/forge-avatars/*", async (c) => {
  const rest = c.req.path.slice("/forge-avatars/".length);
  if (!isForgeAvatarPath(rest)) return c.body(null, 404);
  const forward = new Headers();
  const inm = c.req.header("if-none-match");
  if (inm) forward.set("if-none-match", inm);
  const ims = c.req.header("if-modified-since");
  if (ims) forward.set("if-modified-since", ims);
  let res: Response;
  try {
    res = await fetch(`${c.get("config").forgejoUrl}/${rest}${new URL(c.req.url).search}`, { headers: forward });
  } catch (_err) {
    return c.body(null, 502);
  }
  const passHeaders: Record<string, string> = {};
  for (const h of ["content-type", "cache-control", "etag", "last-modified", "expires"]) {
    const v = res.headers.get(h);
    if (v) passHeaders[h] = v;
  }
  if (res.status === 304) return c.body(null, 304, passHeaders);
  if (!res.ok) return c.body(null, res.status === 404 ? 404 : 502);
  return c.body(await res.arrayBuffer(), 200, passHeaders);
});

web.get("/new", globalRoute(async (c, auth) => {
  const error = c.req.query("error");
  const avatarSrc = await currentUserAvatarSrc(c.get("fjUser"), auth.forgejoToken);
  const t = c.get("t");
  return htmlResponse(
    pageShell({
      title: t("home.new_repo"),
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("workspaces", auth.user.username, avatarSrc, t),
      statusPath: [{ label: t("home.new_repo") }],
      body: html`
        <main class="page">
          <div class="settings-page">
            <div class="page-title compact">
              <div>
                <h1>${t("home.new_repo")}</h1>
              </div>
            </div>
            <section class="settings-section">
              <div class="settings-section-header">
                <h2>Create</h2>
                <p>Creates a Forgejo repository under <strong>${auth.user.username}</strong> and registers it as a Cosheaf workspace.</p>
              </div>
              <form class="settings-form" method="post" action="/new" data-testid="new-repo-form">
                <label class="settings-row">
                  <span>Repository name</span>
                  <input name="slug" data-testid="new-repo-slug" pattern="[A-Za-z0-9._\\-]+" required>
                </label>
                <label class="settings-row">
                  <span>Description</span>
                  <input name="description" data-testid="new-repo-description" placeholder="Optional">
                </label>
                <label class="settings-row">
                  <span>Visibility</span>
                  <select name="visibility" data-testid="new-repo-visibility">
                    <option value="private" selected>Private</option>
                    <option value="public">Public</option>
                  </select>
                </label>
                <label class="settings-row">
                  <span>Required approvals</span>
                  <input name="required_approvals" type="number" min="0" value="1" data-testid="new-repo-required-approvals">
                </label>
                <div class="settings-actions">
                  <button class="button primary" type="submit" data-testid="new-repo-submit">Create repository</button>
                  ${error ? html`<p class="muted" data-testid="new-repo-error">${error}</p>` : ""}
                </div>
              </form>
            </section>
          </div>
        </main>
      `,
    }),
  );
}));

web.post("/new", globalRoute(async (c, auth) => {
  const form = await c.req.parseBody();
  const slug = stringField(form.slug)?.trim();
  // Description is optional and writes to the Forgejo repo description (the
  // same field the settings page edits); an empty one falls back to the repo
  // name on the workspace list.
  const description = stringField(form.description)?.trim() ?? "";
  const visibility = stringField(form.visibility) ?? "private";
  const requiredApprovals = nonNegativeInt(stringField(form.required_approvals) ?? "1");
  if (!slug) return redirect("/new?error=repository+name+required");
  if (!WORKSPACE_SLUG_RE.test(slug)) return redirect("/new?error=invalid+repository+name");
  if (visibility !== "private" && visibility !== "public") {
    return redirect("/new?error=invalid+visibility");
  }
  if (requiredApprovals === null) {
    return redirect("/new?error=invalid+required+approvals");
  }
  const owner = auth.user.username;
  const fj = c.get("fjUser");
  if (await fj.getRepo(owner, slug)) {
    return redirect(`/new?error=${encodeURIComponent(`${owner}/${slug} already exists`)}`);
  }
  try {
    await provisionWorkspace(c.get("db"), fj, c.get("config"), {
      owner,
      repo: slug,
      name: description,
      user: auth.user,
      forgejoUsername: owner,
      provisionVia: "user-pat",
      rollbackCreatedRepoOnLocalFailure: true,
      visibility,
      requiredApprovals,
    });
  } catch (err) {
    return badRequestPage(auth.user.username, `Could not create repository: ${(err as Error).message}`);
  }
  return redirect(repoHref(owner, slug));
}));

web.get("/:owner/:repo/user-suggestions", webRoute(async (c, ctx) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (q.length < 1) return Response.json({ users: [] });
  const users = await ctx.collab.searchUsers(q, 10).catch(() => []);
  const suggestions = users
    .map((user) => user.login)
    .filter(Boolean)
    .slice(0, 10);
  return Response.json({ users: suggestions });
}));

registerAccountRoutes(web);

registerFileRoutes(web);

registerIssueRoutes(web);

registerChatPageRoutes(web);

registerPullRoutes(web);

registerBranchRoutes(web);

registerNotificationActivityRoutes(web);

registerDiagnosticsRoutes(web);

registerSettingsRoutes(web);
