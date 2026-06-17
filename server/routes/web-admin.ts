import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { effectiveRegistrationOpen, isSiteAdmin, setRegistrationOpen } from "../site-admin.js";
import { currentUserAvatarSrc, globalRoute, htmlResponse, notFoundPage, redirect, stringField } from "./web-context.js";
import { pageShell, globalSidebar } from "./web-shell.js";
import { emptyHtml, html } from "./web-html.js";

export function registerAdminRoutes(web: Hono<AppEnv>): void {
  web.get("/admin", globalRoute(async (c, auth) => {
    const db = c.get("db");
    const username = auth.user.username;
    if (!isSiteAdmin(db, username)) return notFoundPage(username, "Not found");

    const registrationOpen = effectiveRegistrationOpen(db, c.get("config"));
    const saved = c.req.query("saved") === "1";
    const avatarSrc = await currentUserAvatarSrc(c.get("fjUser"), auth.forgejoToken);
    return htmlResponse(
      pageShell({
        title: "Admin",
        user: username,
        locale: c.get("locale"),
        sidebar: globalSidebar("admin", username, avatarSrc, c.get("t"), { siteAdmin: true }),
        body: html`
          <main class="page">
            <div class="page-title">
              <div>
                <h1>Admin</h1>
                <p>Site-wide controls for Cosheaf.</p>
              </div>
            </div>
            <div class="settings-page">
              <section class="settings-section" data-testid="site-registration">
                <div class="settings-section-header">
                  <h2>Registration</h2>
                  <p>Controls whether new users can create accounts from the public sign-up page.</p>
                </div>
                <form class="settings-form" method="post" action="/admin/registration">
                  <label class="settings-row">
                    <span>Status</span>
                    <select name="registration_open" data-testid="registration-open-select">
                      <option value="open" ${registrationOpen ? "selected" : ""}>Open</option>
                      <option value="closed" ${registrationOpen ? "" : "selected"}>Closed</option>
                    </select>
                  </label>
                  <div class="settings-actions">
                    <button class="button primary" type="submit">Save</button>
                    ${saved ? html`<p class="muted" data-testid="admin-saved">Saved.</p>` : emptyHtml}
                  </div>
                </form>
              </section>
            </div>
          </main>
        `,
      }),
    );
  }));

  web.post("/admin/registration", globalRoute(async (c, auth) => {
    const db = c.get("db");
    const username = auth.user.username;
    if (!isSiteAdmin(db, username)) return notFoundPage(username, "Not found");

    const form = await c.req.parseBody();
    const mode = stringField(form.registration_open);
    if (mode !== "open" && mode !== "closed") return redirect("/admin");
    setRegistrationOpen(db, mode === "open", username);
    return redirect("/admin?saved=1");
  }));
}
