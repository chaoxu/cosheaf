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
import { badRequestPage, configReposForUser, htmlResponse, positiveInt, redirect, repoHref, resolveWebAuth, stringField } from "./web-context.js";
import { mapThread } from "./notifications.js";
import type { NotificationRow } from "../../shared/issues.js";
import { registerBranchRoutes, registerFileRoutes } from "./web-files.js";
import { registerIssueRoutes } from "./web-issues.js";
import { userPreferencesSection, userPreferencesScript, userProfileSection } from "./web-page.js";
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
  const inbox = threads.map(mapThread).filter((row): row is NotificationRow => row !== null);
  return htmlResponse(
    pageShell({
      title: "Repositories",
      user: auth.user.username,
      sidebar: globalSidebar("workspaces"),
      body: html`
        <main class="page">
          <div class="page-title">
            <div>
              <p class="eyebrow">Repositories</p>
              <h1>${auth.user.username}</h1>
            </div>
            <a class="button primary" href="/new" data-testid="new-repo">New repository</a>
          </div>
          ${inboxSection(inbox)}
          <div class="list">
            ${repos.length === 0
              ? html`<div class="empty">No repositories available.</div>`
              : repos.map(
                  (repo) => html`
                  <a class="list-row" href="${repoHref(repo.owner, repo.name)}">
                    <strong>${repo.full_name}</strong>
                    <span>${repo.description ?? ""}</span>
                    <small>${repo.private ? "private" : "public"} · ${repo.role}</small>
                  </a>
                `,
                )}
          </div>
        </main>
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
    <div class="inbox-head"><h2>Inbox</h2><span class="inbox-count">${rows.length} unread</span></div>
    <div class="list">
      ${rows.map(
        (row) => html`<div class="list-row inbox-row">
          <a class="inbox-link" href="/${row.repo}/${row.kind === "pr" ? "pulls" : "issues"}/${row.number}">
            <span class="inbox-kind ${row.kind}">${row.kind === "pr" ? "PR" : "issue"}</span>
            <strong>${row.title}</strong>
            <small>${row.repo} #${row.number}</small>
          </a>
          <form method="post" action="/account/notifications/${row.id}/read">
            <button class="button small" type="submit" title="Mark read">Done</button>
          </form>
        </div>`,
      )}
    </div>
  </section>`;
}

web.post("/account/notifications/:id/read", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
  const id = positiveInt(c.req.param("id"));
  if (id) await c.get("fjUser").markNotificationRead(id).catch(() => {});
  return redirect("/");
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
      sidebar: globalSidebar("account"),
      statusPath: [{ label: "account" }],
      body: html`
        <main class="page">
          <div class="settings-page account-settings">
            <div class="page-title compact">
              <div>
                <p class="eyebrow">Account</p>
                <h1>Settings</h1>
              </div>
            </div>
            ${userProfileSection(me, { saved, error })}
            ${userPreferencesSection(auth.user.username)}
          </div>
        </main>
        ${userPreferencesScript()}
      `,
    }),
  );
});

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
      sidebar: globalSidebar("workspaces"),
      statusPath: [{ label: "new repository" }],
      body: html`
        <main class="page">
          <div class="settings-page">
            <div class="page-title compact">
              <div>
                <p class="eyebrow">Repositories</p>
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
