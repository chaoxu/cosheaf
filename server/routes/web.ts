import { Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, setCookie } from "hono/cookie";
import { AUTH_COOKIE } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { WORKSPACE_SLUG_RE } from "../../shared/conventions.js";
import { allDocumentFormats } from "../format-registry.js";
import { DEFAULT_CREATE_FORMAT_ID, isDocumentFormatId } from "../../shared/document-format.js";
import { provisionWorkspace } from "../workspace-provisioning.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { registerNotificationActivityRoutes } from "./web-activity.js";
import { registerChatPageRoutes } from "./web-chat-pages.js";
import { badRequestPage, configReposForUser, htmlResponse, positiveInt, redirect, repoHref, resolveWebAuth, safeWebRedirect, stringField } from "./web-context.js";
import { mapThreads } from "./notifications.js";
import type { NotificationRow } from "../../shared/issues.js";
import { registerBranchRoutes, registerFileRoutes } from "./web-files.js";
import { registerIssueRoutes } from "./web-issues.js";
import { userPreferencesSection, userProfileSection } from "./web-page.js";
import { registerPullRoutes } from "./web-pulls.js";
import { registerSettingsRoutes } from "./web-settings.js";
import { emptyHtml, html, type Html } from "./web-html.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export const web = new Hono<AppEnv>();
web.use("*", compress());

web.get("/login", (_c) =>
  htmlResponse(
    pageShell({
      title: "Sign in",
      body: html`
        <main class="auth-page">
          <form class="auth-card" method="post" action="/login">
            <h1>Cosheaf</h1>
            <label>Username <input name="username" autocomplete="username" required></label>
            <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">Sign in</button>
          </form>
        </main>
      `,
    }),
  ),
);

web.post("/login", async (c) => {
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
  setCookie(c, AUTH_COOKIE, outcome.pat, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: c.req.url.startsWith("https://"),
  });
  return c.redirect("/", 303);
});

web.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.redirect("/login", 303);
});

web.get("/", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const [repos, threads] = await Promise.all([
    configReposForUser(c),
    // Forgejo's account-level notifications are already cross-repo — the daily
    // "what needs my attention anywhere" inbox the per-repo tab can't give.
    c.get("fjUser").listNotifications({ statusTypes: ["unread"], subjectTypes: ["Issue", "Pull"] }).catch(() => []),
  ]);
  const inbox = mapThreads(threads);
  return htmlResponse(
    pageShell({
      title: "Repositories",
      user: auth.user.username,
      sidebar: globalSidebar("workspaces", auth.user.username),
      body: html`
        <main class="page">
          <div class="page-title page-title--actions-only">
            <a class="button primary" href="/new" data-testid="new-repo">New repository</a>
          </div>
          <div id="home-inbox-slot">${inboxSection(inbox)}</div>
          <div class="list">
            ${repos.length === 0
              ? html`<div class="empty">No repositories available.</div>`
              : repos.map(
                  (repo) => html`
                  <a class="list-row repo-row" href="${repoHref(repo.owner, repo.name)}">
                    <span class="repo-row-main">
                      <strong class="ws-slug">${repo.full_name}</strong>
                      ${repo.description ? html`<span class="ws-title">${repo.description}</span>` : emptyHtml}
                    </span>
                    <small>${repo.private ? "private" : "public"} · ${repo.role}</small>
                  </a>
                `,
                )}
          </div>
        </main>
        <script src="/cosheaf-inbox.js" defer></script>
      `,
    }),
  );
});

// Cross-repo unread inbox on the home page. Each row links to the cosheaf
// issue/PR route and carries a subtle mark-read action. Rendered only when
// there are unread threads, so home stays clean when caught up.
function inboxSection(rows: readonly NotificationRow[]): Html {
  if (rows.length === 0) return emptyHtml;
  return html`<section class="inbox" data-testid="home-inbox">
    <div class="inbox-head">
      <h2>Inbox</h2>
      <span class="inbox-count">${rows.length} unread</span>
      <form method="post" action="/account/notifications/read-all"><button class="button small" type="submit">Mark all read</button></form>
    </div>
    <div class="list">
      ${rows.map((row) => notificationRow(row))}
    </div>
  </section>`;
}

// One cross-repo notification row, shared by the home inbox and the dedicated
// account notifications page. `next` (when given) rides the mark-read POST so
// the handler returns to the page the row was acted on from.
function notificationRow(row: NotificationRow, next?: string): Html {
  return html`<div class="list-row inbox-row">
    <a class="inbox-link" href="/${row.repo}/${row.kind === "pr" ? "pulls" : "issues"}/${row.number}">
      <span class="inbox-kind ${row.kind}">${row.kind === "pr" ? "PR" : "issue"}</span>
      <strong>${row.title}</strong>
      <small>${row.repo} #${row.number}</small>
    </a>
    <form method="post" action="/account/notifications/${row.id}/read">
      ${next ? html`<input type="hidden" name="next" value="${next}">` : ""}
      <button class="button small" type="submit" title="Mark read">Done</button>
    </form>
  </div>`;
}

// The dedicated /account/notifications feed (#129). Unlike the home inbox it
// always renders — including a calm empty state — so the affordance is
// discoverable rather than appearing only when something is unread. Mark-read
// forms carry `next` so the POST handlers return here instead of home.
function notificationsAccountPage(rows: readonly NotificationRow[], all: boolean): Html {
  const NEXT = "/account/notifications";
  const toggle = html`<span class="state-toggles" aria-label="Filter">
    <a class="state-toggle ${all ? "" : "active"}" href="/account/notifications">unread</a> ·
    <a class="state-toggle ${all ? "active" : ""}" href="/account/notifications?state=all">all</a>
  </span>`;
  return html`<main class="page">
    <div class="page-title">
      <h1>Notifications</h1>
      <div class="toolbar-actions">
        ${toggle}
        ${rows.length === 0 ? "" : html`<form method="post" action="/account/notifications/read-all"><input type="hidden" name="next" value="${NEXT}"><button class="button small" type="submit">Mark all read</button></form>`}
      </div>
    </div>
    ${
      rows.length === 0
        ? html`<div class="empty" data-testid="notifications-empty">${all ? "No notifications." : "You're all caught up."}</div>`
        : html`<div class="list" data-testid="notifications-list">
            ${rows.map((row) => notificationRow(row, NEXT))}
          </div>`
    }
  </main>`;
}

// Server-rendered inbox fragment the home page swaps in on a live notification
// SSE hint (#116), so the inbox HTML is never duplicated in client JS.
web.get("/account/inbox", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const threads = await c
    .get("fjUser")
    .listNotifications({ statusTypes: ["unread"], subjectTypes: ["Issue", "Pull"] })
    .catch(() => []);
  return htmlResponse(String(inboxSection(mapThreads(threads))));
});

web.post("/account/notifications/:id/read", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const id = positiveInt(c.req.param("id"));
  if (id) await c.get("fjUser").markNotificationRead(id).catch(() => {});
  // Home inbox forms omit `next` and fall back to "/"; the account
  // notifications page passes its own path so it returns there.
  return redirect(safeWebRedirect(stringField((await c.req.parseBody()).next)) ?? "/");
});

web.post("/account/notifications/read-all", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  await c.get("fjUser").markAllNotificationsRead().catch(() => {});
  return redirect(safeWebRedirect(stringField((await c.req.parseBody()).next)) ?? "/");
});

// Dedicated cross-repo notifications page (#129): the persistent global feed
// reachable from the sidebar on every page, including when empty. Unread by
// default; `?state=all` includes already-read threads. Mark-read reuses the
// POST handlers above (passing `next` so they return here).
web.get("/account/notifications", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const all = c.req.query("state") === "all";
  const threads = await c
    .get("fjUser")
    .listNotifications({
      statusTypes: all ? ["unread", "read", "pinned"] : ["unread"],
      subjectTypes: ["Issue", "Pull"],
    })
    .catch(() => []);
  return htmlResponse(
    pageShell({
      title: "Notifications",
      user: auth.user.username,
      sidebar: globalSidebar("notifications", auth.user.username),
      statusPath: [{ label: "notifications" }],
      body: notificationsAccountPage(mapThreads(threads), all),
    }),
  );
});

web.get("/account/settings", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const me = await c.get("fjUser").getCurrentUser();
  const saved = c.req.query("saved") === "1";
  const error = c.req.query("error") ?? undefined;
  return htmlResponse(
    pageShell({
      title: "Account settings",
      user: auth.user.username,
      sidebar: globalSidebar("account", auth.user.username),
      statusPath: [{ label: "account" }],
      body: html`
        <main class="page">
          <div class="settings-page account-settings">
            <div class="page-title compact">
              <div>
                <h1>Settings</h1>
              </div>
            </div>
            ${userProfileSection(me, { saved, error })}
            ${userPreferencesSection(auth.user.username)}
            ${accountSignOutSection()}
          </div>
        </main>
      `,
    }),
  );
});

// Sign-out lives on the Account page (#127) instead of an always-present
// status-bar button. A plain POST form to /logout — no island needed.
function accountSignOutSection(): Html {
  return html`<section class="settings-section" data-testid="account-signout">
    <div class="settings-section-header">
      <h2>Session</h2>
      <p>Sign out of Cosheaf on this device.</p>
    </div>
    <form class="settings-form" method="post" action="/logout">
      <div class="settings-actions">
        <button class="button" type="submit" data-testid="signout">Sign out</button>
      </div>
    </form>
  </section>`;
}

web.post("/account/settings", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
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
    return redirect(`/account/settings?error=${encodeURIComponent(`Could not save profile: ${(err as Error).message}`)}`);
  }
  return redirect("/account/settings?saved=1");
});

web.get("/new", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const error = c.req.query("error");
  return htmlResponse(
    pageShell({
      title: "New repository",
      user: auth.user.username,
      sidebar: globalSidebar("workspaces", auth.user.username),
      statusPath: [{ label: "new repository" }],
      body: html`
        <main class="page">
          <div class="settings-page">
            <div class="page-title compact">
              <div>
                <h1>New repository</h1>
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
                  <input name="slug" data-testid="new-repo-slug" pattern="[A-Za-z0-9._-]+" required>
                </label>
                <label class="settings-row">
                  <span>Description</span>
                  <input name="description" data-testid="new-repo-description" placeholder="Optional">
                </label>
                <label class="settings-row">
                  <span>Document format</span>
                  <select name="default_md_format" data-testid="new-repo-format">
                    ${allDocumentFormats().map(
                      (f) => html`<option value="${f.id}" ${f.id === DEFAULT_CREATE_FORMAT_ID ? "selected" : ""}>${f.id}</option>`,
                    )}
                  </select>
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
});

web.post("/new", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const form = await c.req.parseBody();
  const slug = stringField(form.slug)?.trim();
  // Description is optional and writes to the Forgejo repo description (the
  // same field the settings page edits); an empty one falls back to the repo
  // name on the workspace list.
  const description = stringField(form.description)?.trim() ?? "";
  const formatRaw = stringField(form.default_md_format) ?? undefined;
  if (!slug) return redirect("/new?error=repository+name+required");
  if (!WORKSPACE_SLUG_RE.test(slug)) return redirect("/new?error=invalid+repository+name");
  if (formatRaw !== undefined && !isDocumentFormatId(formatRaw)) {
    return redirect("/new?error=invalid+format");
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
    });
  } catch (err) {
    return badRequestPage(auth.user.username, `Could not create repository: ${(err as Error).message}`);
  }
  return redirect(repoHref(owner, slug));
});

registerFileRoutes(web);

registerIssueRoutes(web);

registerChatPageRoutes(web);

registerPullRoutes(web);

registerBranchRoutes(web);

registerNotificationActivityRoutes(web);

registerSettingsRoutes(web);
