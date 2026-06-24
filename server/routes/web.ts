import { type Context, Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie } from "hono/cookie";
import { FORGEJO_NAME_RE, WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { DEFAULT_CREATE_FORMAT_ID, isDocumentFormatId } from "../../shared/document-format.js";
import type { LocaleId, MessageKey, T } from "../../shared/i18n/index.js";
import type { NotificationRow } from "../../shared/issues.js";
import { ForgejoError } from "../forgejo.js";
import type { ForgejoSshKey, ForgejoUser } from "../forgejo-types.js";
import { allDocumentFormats } from "../format-registry.js";
import { AUTH_COOKIE } from "../middleware.js";
import { FixedWindowRateLimiter } from "../rate-limit.js";
import { effectiveRegistrationOpen, isSiteAdmin, registrationInviteForToken, releaseRegistrationInvite, reserveRegistrationInvite } from "../site-admin.js";
import type { AppEnv } from "../types.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { avatarForUser, avatarLinkForUser, forgeAvatarSrc, hasCustomAvatar, isForgeAvatarPath } from "./avatar.js";
import { mapThreads } from "./notifications.js";
import { registerNotificationActivityRoutes } from "./web-activity.js";
import { registerAdminRoutes } from "./web-admin.js";
import { registerBranchRoutes } from "./web-branches.js";
import { registerChatPageRoutes } from "./web-chat-pages.js";
import { badRequestPage, clientIp, configReposForUser, currentUserAvatarSrc, globalRoute, htmlResponse, invalidateCurrentUserAvatar, nonNegativeInt, notFoundPage, positiveInt, redirect, rejectCrossOriginMutation, repoHref, safeWebRedirect, setAuthCookie, stringField, textField, webRoute } from "./web-context.js";
import { registerDiagnosticsRoutes } from "./web-diagnostics.js";
import { registerFileRoutes } from "./web-files.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { registerIssueRoutes } from "./web-issues.js";
import { addDisclosure, userPreferencesSection, userProfileSection } from "./web-page.js";
import { registerPullRoutes } from "./web-pulls.js";
import { registerSettingsRoutes } from "./web-settings.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export const web = new Hono<AppEnv>();
web.use("*", compress());

type GlobalWebAuth = Parameters<Parameters<typeof globalRoute>[0]>[1];

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
  setAuthCookie(c, outcome.pat);
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
  setAuthCookie(c, outcome.pat);
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

web.get("/help", globalRoute(async (c, auth) => {
  const t = c.get("t");
  const avatarSrc = await currentUserAvatarSrc(c.get("fjUser"), auth.forgejoToken);
  return htmlResponse(
    pageShell({
      title: t("nav.help"),
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("help", auth.user.username, avatarSrc, t, { siteAdmin: isSiteAdmin(c.get("db"), auth.user.username) }),
      statusPath: [{ label: t("nav.help") }],
      body: helpPage(),
    }),
  );
}));

function helpPage(): Html {
  return html`<main class="page help-page" data-testid="help-page">
    <div class="page-title compact">
      <div>
        <h1>How Cosheaf works</h1>
        <p class="muted">The short version of the account, workspace, page, review, and agent model.</p>
      </div>
    </div>

    <section class="help-hero">
      <div>
        <h2>Use it like a focused repository</h2>
        <p>Cosheaf is a web interface for writing and reviewing Markdown knowledge bases. Files live in Forgejo repositories. Cosheaf adds page rendering, search, backlinks, review screens, and a simpler browser workflow.</p>
      </div>
      <ol class="help-steps">
        <li><strong>Find a workspace.</strong> Open any repository you can access.</li>
        <li><strong>Edit on a branch.</strong> Changes stay private to that branch until reviewed.</li>
        <li><strong>Open a pull request.</strong> Ask collaborators to review the branch.</li>
        <li><strong>Merge to main.</strong> The merged Markdown becomes the canonical knowledge base.</li>
      </ol>
    </section>

    <section class="help-grid" aria-label="Cosheaf terms">
      ${helpCard("Account", "Your Cosheaf account is your Forgejo account. Your username, profile, repository access, SSH keys, and notifications come from the forge.")}
      ${helpCard("Workspace", "A workspace is one repository, such as owner/repo. If you can read the repository in Forgejo, it can appear in Cosheaf.")}
      ${helpCard("Page", "A page is a Markdown file. In Coflat workspaces, pages may also have math, citations, cross-references, and stable frontmatter ids.")}
      ${helpCard("Branch", "A branch is where unfinished edits live. Branches let people and agents work without changing the published main branch.")}
      ${helpCard("Pull request", "A pull request is the review record for a branch. Use it to compare changes, comment, approve, request changes, and merge.")}
      ${helpCard("Issue", "An issue tracks work or discussion. Issues can carry labels, milestones, comments, dependencies, and notifications.")}
      ${helpCard("Review", "A review is a durable approval or change request on a pull request. Cosheaf uses Forgejo's review state as the source of truth.")}
      ${helpCard("Agent", "An agent is just another collaborator with repository access. It writes branches, opens pull requests, comments, and reviews through the Cosheaf API.")}
      ${helpCard("Format", "Forgejo Markdown workspaces render plain Markdown. Coflat workspaces add math-friendly rendering, backlinks, and richer document review.")}
    </section>

    <section class="help-section">
      <h2>Common workflows</h2>
      <div class="help-workflows">
        ${workflow("Write a new page", ["Open a workspace.", "Use Files to create or edit a .md file.", "Save on a named branch.", "Open a pull request when the branch is ready."])}
        ${workflow("Review a change", ["Open Pull requests.", "Inspect the changed files in source or rich view.", "Comment where the wording or math needs work.", "Approve or request changes."])}
        ${workflow("Find related knowledge", ["Search from the workspace files view.", "Open a page and follow its references.", "Use backlinks to see what points at the current page.", "Use issues when the missing knowledge should become work."])}
        ${workflow("Invite someone", ["Open repository Settings.", "Grant repository access to a username.", "Tell them to sign in and open the workspace.", "Use issues or pull requests to coordinate the first task."])}
      </div>
    </section>

    <section class="help-section">
      <h2>What is durable?</h2>
      <p>Repository files, branches, pull requests, reviews, issues, comments, labels, milestones, memberships, and notifications live in Forgejo. Cosheaf's database is a rebuildable sidecar for search, backlinks, document metadata, webhook dedupe, and browser login tokens.</p>
      <p>That means the safe mental model is simple: if a fact must be permanent, put it in a Markdown file, issue, pull request, review, or comment.</p>
    </section>
  </main>`;
}

function helpCard(title: string, body: string): Html {
  return html`<article class="help-card">
    <h2>${title}</h2>
    <p>${body}</p>
  </article>`;
}

function workflow(title: string, steps: readonly string[]): Html {
  return html`<article class="help-workflow">
    <h3>${title}</h3>
    <ol>${steps.map((step) => html`<li>${step}</li>`)}</ol>
  </article>`;
}

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

web.get("/users", globalRoute(async (c, auth) => usersIndexResponse(c, auth)));
web.get("/users/", globalRoute(async (c, auth) => usersIndexResponse(c, auth)));

async function usersIndexResponse(c: Context<AppEnv>, auth: GlobalWebAuth): Promise<Response> {
  const fj = c.get("fjUser");
  const [users, avatarSrc] = await Promise.all([
    fj.listUsers(),
    currentUserAvatarSrc(fj, auth.forgejoToken),
  ]);
  const sorted = [...users].sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: "base" }));
  return htmlResponse(
    pageShell({
      title: "Users",
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("workspaces", auth.user.username, avatarSrc, c.get("t")),
      statusPath: [{ label: "users" }],
      body: usersIndexPage(sorted),
    }),
  );
}

function usersIndexPage(users: readonly ForgejoUser[]): Html {
  return html`<main class="page users-page" data-testid="users-page">
    <div class="page-title">
      <h1>Users</h1>
    </div>
    ${
      users.length === 0
        ? html`<div class="empty">No users found.</div>`
        : html`<div class="list users-list">
          ${users.map((user) => {
            const displayName = user.full_name?.trim() || user.login;
            return html`<a class="list-row user-row" href="${`/users/${encodeURIComponent(user.login)}`}">
              ${avatarForUser(user)}
              <span class="list-row-main">
                <strong>${displayName}</strong>
                <small>${user.login}</small>
                ${user.description ? html`<span class="muted">${user.description}</span>` : emptyHtml}
              </span>
            </a>`;
          })}
        </div>`
    }
  </main>`;
}

web.get("/users/:username", globalRoute(async (c, auth) => {
  const username = c.req.param("username");
  if (!username || !FORGEJO_NAME_RE.test(username)) return notFoundPage(auth.user.username, "User not found");
  const fj = c.get("fjUser");
  const [profile, repos, avatarSrc] = await Promise.all([
    fj.getUserByName(username),
    fj.listUserRepos(username).catch(() => []),
    currentUserAvatarSrc(fj, auth.forgejoToken),
  ]);
  if (!profile) return notFoundPage(auth.user.username, "User not found");
  const website = profile.website ? normalizedExternalHref(profile.website) : null;
  const displayName = profile.full_name?.trim() || profile.login;
  const repoCount = repos.length;
  return htmlResponse(
    pageShell({
      title: `${displayName} - Cosheaf`,
      user: auth.user.username,
      locale: c.get("locale"),
      sidebar: globalSidebar("workspaces", auth.user.username, avatarSrc, c.get("t")),
      statusPath: [{ label: "users" }, { label: profile.login }],
      body: html`<main class="page user-page" data-testid="user-page">
        <section class="settings-section user-profile-card">
          <div class="user-profile-header">
            <div class="user-profile-main">
              <div class="user-profile-avatar">${avatarLinkForUser(profile)}</div>
              <div class="user-profile-identity">
                <h1>${displayName}</h1>
                <p>${profile.login}</p>
                <div class="profile-badges">
                  <span>${repoCount} ${repoCount === 1 ? "repository" : "repositories"}</span>
                  ${profile.active === false ? html`<span>Inactive</span>` : html`<span>Active</span>`}
                  ${profile.is_admin ? html`<span>Site admin</span>` : emptyHtml}
                </div>
              </div>
            </div>
            ${profile.login === auth.user.username ? html`<a class="button user-profile-edit" href="/account/settings">Edit profile</a>` : emptyHtml}
          </div>
          ${profile.description ? html`<p>${profile.description}</p>` : emptyHtml}
          ${
            profile.location || website
              ? html`<dl class="meta-list">
                ${profile.location ? html`<div><dt>Location</dt><dd>${profile.location}</dd></div>` : emptyHtml}
                ${website ? html`<div><dt>Website</dt><dd><a href="${website}" rel="nofollow noreferrer">${website}</a></dd></div>` : emptyHtml}
              </dl>`
              : emptyHtml
          }
        </section>
        <section class="settings-section">
          <div class="settings-section-header">
            <h2>Repositories</h2>
            <p>${repoCount} Forgejo ${repoCount === 1 ? "repository" : "repositories"} visible to you.</p>
          </div>
          ${
            repos.length === 0
              ? html`<div class="empty">No visible repositories.</div>`
              : html`<div class="list">${repos.map((repo) => html`
                <a class="list-row" href="${repoHref(repo.owner.login, repo.name)}">
                  <span class="list-row-main">
                    <strong>${repo.full_name || `${repo.owner.login}/${repo.name}`}</strong>
                    ${repo.description ? html`<span class="muted">${repo.description}</span>` : emptyHtml}
                    <small>${repo.private ? "Private" : "Visible"}${repo.default_branch ? ` · ${repo.default_branch}` : ""}</small>
                  </span>
                </a>
              `)}</div>`
          }
        </section>
      </main>`,
    }),
  );
}));

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
  setAuthCookie(c, outcome.pat);
  return accountSettingsResponse(c, auth, { apiToken: outcome.pat });
}));

function normalizedExternalHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch (_err) {
    return null;
  }
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
              <p>Send it as <code>Authorization: Bearer &lt;token&gt;</code>. Treat it like your password.</p>
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

const settingsError = (msg: string): Response => redirect(`/account/settings?error=${encodeURIComponent(msg)}`);
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const AVATAR_MAX_BYTES = 1_000_000;
const AVATAR_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

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
                  <span>Document format</span>
                  <select name="default_md_format" data-testid="new-repo-format">
                    ${allDocumentFormats().map(
                      (f) => html`<option value="${f.id}" ${f.id === DEFAULT_CREATE_FORMAT_ID ? "selected" : ""}>${f.id}</option>`,
                    )}
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
  const formatRaw = stringField(form.default_md_format) ?? undefined;
  const visibility = stringField(form.visibility) ?? "private";
  const requiredApprovals = nonNegativeInt(stringField(form.required_approvals) ?? "1");
  if (!slug) return redirect("/new?error=repository+name+required");
  if (!WORKSPACE_SLUG_RE.test(slug)) return redirect("/new?error=invalid+repository+name");
  if (formatRaw !== undefined && !isDocumentFormatId(formatRaw)) {
    return redirect("/new?error=invalid+format");
  }
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
      defaultMdFormat: formatRaw,
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
  const users = await ctx.fj.searchUsers(q, 10).catch(() => []);
  const suggestions = users
    .map((user) => user.login)
    .filter(Boolean)
    .slice(0, 10);
  return Response.json({ users: suggestions });
}));

registerFileRoutes(web);

registerIssueRoutes(web);

registerChatPageRoutes(web);

registerPullRoutes(web);

registerBranchRoutes(web);

registerNotificationActivityRoutes(web);

registerDiagnosticsRoutes(web);

registerSettingsRoutes(web);
