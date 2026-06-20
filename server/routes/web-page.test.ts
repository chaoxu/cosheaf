import { describe, expect, it } from "vitest";
import { makeT } from "../../shared/i18n/index.js";
import { repoPage } from "./web-page.js";
import { html } from "./web-html.js";

describe("repo page status bar", () => {
  it("links the owner crumb to the user profile and keeps the repo crumb unchanged", () => {
    const body = repoPage({
      title: "Files",
      owner: "alice bob",
      repo: "notes repo",
      active: "files",
      user: "alice bob",
      ws: {
        owner: "alice bob",
        repo: "notes repo",
        slug: "alice bob/notes repo",
        defaultMdFormat: "coflat",
        role: "admin",
      },
      wsTitle: "Notes",
      body: html``,
      locale: "en",
      t: makeT("en"),
    });

    expect(body).toContain('class="status-owner" href="/users/alice%20bob"');
    expect(body).toContain('href="/alice%20bob/notes%20repo"');
  });
});
