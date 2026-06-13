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
import { badRequestPage, configReposForUser, htmlResponse, redirect, repoHref, resolveWebAuth, stringField } from "./web-context.js";
import { registerBranchRoutes, registerFileRoutes } from "./web-files.js";
import { registerIssueRoutes } from "./web-issues.js";
import { userPreferencesSection, userPreferencesScript } from "./web-page.js";
import { registerPullRoutes } from "./web-pulls.js";
import { registerSettingsRoutes } from "./web-settings.js";
import { html } from "./web-html.js";
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
  const repos = await configReposForUser(c);
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
          <div class="list">
            ${repos.length === 0
              ? html`<div class="empty">No repositories available.</div>`
              : repos.map(
                  (repo) => html`
                  <a class="list-row" href="${repoHref(repo.owner, repo.name)}">
                    <strong>${repo.full_name}</strong>
                    <span>${repo.description ?? ""}</span>
                    <small>${repo.role}</small>
                  </a>
                `,
                )}
          </div>
        </main>
      `,
    }),
  );
});

web.get("/account/settings", async (c) => {
  const auth = await resolveWebAuth(c);
  if (!auth) return redirect("/login");
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
            ${userPreferencesSection(auth.user.username)}
          </div>
        </main>
        ${userPreferencesScript()}
      `,
    }),
  );
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
