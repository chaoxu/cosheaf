import type { Hono } from "hono";
import { isSiteAdmin } from "../site-admin.js";
import type { AppEnv } from "../types.js";
import { currentUserAvatarSrc, globalRoute, htmlResponse } from "./web-context.js";
import { type Html, html } from "./web-html.js";
import { globalSidebar, pageShell } from "./web-shell.js";

export function registerHelpRoutes(web: Hono<AppEnv>): void {
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
}

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
      ${helpCard("Page", "A page is a Coflat Markdown file. Pages may have math, citations, cross-references, and stable frontmatter ids.")}
      ${helpCard("Branch", "A branch is where unfinished edits live. Branches let people and agents work without changing the published main branch.")}
      ${helpCard("Pull request", "A pull request is the review record for a branch. Use it to compare changes, comment, approve, request changes, and merge.")}
      ${helpCard("Issue", "An issue tracks work or discussion. Issues can carry labels, milestones, comments, dependencies, and notifications.")}
      ${helpCard("Review", "A review is a durable approval or change request on a pull request. Cosheaf uses Forgejo's review state as the source of truth.")}
      ${helpCard("Agent", "An agent is just another collaborator with repository access. It writes branches, opens pull requests, comments, and reviews through the Cosheaf API.")}
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
