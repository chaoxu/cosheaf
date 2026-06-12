import { Hono } from "hono";
import { compress } from "hono/compress";
import { deleteCookie, setCookie } from "hono/cookie";
import { AUTH_COOKIE } from "../middleware.js";
import type { AppEnv } from "../types.js";
import { exchangeForgejoCredsForPat } from "./auth.js";
import { escapeHtml } from "./html-escape.js";
import { registerNotificationActivityRoutes } from "./web-activity.js";
import { registerChatPageRoutes } from "./web-chat-pages.js";
import { configReposForUser, htmlResponse, redirect, repoHref, resolveWebAuth, stringField } from "./web-context.js";
import { registerBranchRoutes, registerFileRoutes } from "./web-files.js";
import { registerIssueRoutes } from "./web-issues.js";
import { userPreferencesSection, userPreferencesScript } from "./web-page.js";
import { registerPullRoutes } from "./web-pulls.js";
import { registerSettingsRoutes } from "./web-settings.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export const web = new Hono<AppEnv>();
web.use("*", compress());

web.get("/login", (_c) =>
  htmlResponse(
    pageShell({
      title: "Sign in",
      body: `
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
  const config = c.get("config");
  const repos = await configReposForUser(c);
  return htmlResponse(
    pageShell({
      title: "Repositories",
      user: auth.user.username,
      sidebar: globalSidebar("workspaces"),
      body: `
        <main class="page">
          <div class="page-title">
            <div>
              <p class="eyebrow">Repositories</p>
              <h1>${escapeHtml(config.forgejoOwner)}</h1>
            </div>
          </div>
          <div class="list">
            ${repos
              .map(
                (repo) => `
                  <a class="list-row" href="${repoHref(config.forgejoOwner, repo.name)}">
                    <strong>${escapeHtml(repo.name)}</strong>
                    <span>${escapeHtml(repo.description ?? "")}</span>
                    <small>${escapeHtml(repo.role)}</small>
                  </a>
                `,
              )
              .join("") || `<div class="empty">No repositories available.</div>`}
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
      body: `
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

registerFileRoutes(web);

registerIssueRoutes(web);

registerChatPageRoutes(web);

registerPullRoutes(web);

registerBranchRoutes(web);

registerNotificationActivityRoutes(web);

registerSettingsRoutes(web);
