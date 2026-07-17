import { type Context, type Hono } from "hono";
import { FORGEJO_NAME_RE } from "../../shared/conventions.js";
import type { ForgejoUser } from "../forgejo-types.js";
import type { AppEnv } from "../types.js";
import { avatarForUser, avatarLinkForUser } from "./avatar.js";
import { currentUserAvatarSrc, globalRoute, htmlResponse, notFoundPage, repoHref } from "./web-context.js";
import { emptyHtml, type Html, html } from "./web-html.js";
import { globalSidebar, pageShell } from "./web-shell.js";

type GlobalWebAuth = Parameters<Parameters<typeof globalRoute>[0]>[1];

export function registerUserRoutes(web: Hono<AppEnv>): void {
  web.get("/users", globalRoute(async (c, auth) => usersIndexResponse(c, auth)));
  web.get("/users/", globalRoute(async (c, auth) => usersIndexResponse(c, auth)));

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
                <div class="user-profile-avatar">${avatarLinkForUser(profile, false)}</div>
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
}

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

function normalizedExternalHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch (_err) {
    return null;
  }
}
