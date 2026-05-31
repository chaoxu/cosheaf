# Manual smoke checklist

Run after `pnpm setup:dev` (or after any non-trivial change). Walks every
user-visible path. Per-format expectations are noted where they differ.

The seeded workspace is **Flushing Coin** (`flushing-coin`), default format
`coflat`. To smoke the passthrough format too, create a second workspace
with `default_md_format = forgejo-passthrough` via the settings panel.

## 1. Login + workspace switch
- [ ] `/` → login form. Sign in as `chao` / `Cosheaf123!`.
- [ ] Repository **flushing-coin** is listed; click it.
- [ ] The server-rendered repository page opens at `/flushing-coin` and the
      **Files** tab is active. `/app` and `/w/flushing-coin` should not show an
      app shell.

## 2. File tree, read, write
- [ ] The file list shows `hello.md` and the showcase fixture.
- [ ] Open `hello.md` through `/src/branch/main/hello.md`; the reader renders
      the document with normal repository navigation.
- [ ] Use **New file** or **Edit** to open `/_edit`.
- [ ] Edit the body, click **Save**; the status bar says `saved` and shows the
      `user/<name>/wip-…` branch.
- [ ] Save again; it pushes more commits to the same branch.

## 3. Asset upload
- [ ] Drag an image into the editor (or paste). Image appears in the doc as
      `![](assets/...)`.
- [ ] Save. The asset file is committed alongside the markdown.

## 4. Search, backlinks, validation
- [ ] Use the typed search/backlinks/validation API from `API.md` for this
      sidecar behavior until those utility panels have server-rendered pages.
- [ ] For Coflat workspaces, `GET /api/v1/w/flushing-coin/backlinks?id=hello`
      returns derived references; passthrough workspaces return no Coflat
      backlinks.

## 5. Branches
- [ ] **Files** → **New file** or save a new edit → creates a `user/<me>/wip-…`
      branch and an `active-branch-name` chip in the editor.
- [ ] Open `/flushing-coin/branches`; the branch appears in the server-rendered
      branch list.
- [ ] Delete the branch via Forgejo's UI (or `tea branches delete`); refresh
      `/flushing-coin/branches` and confirm it disappears.

## 6. Pull-request lifecycle
- [ ] On a `user/<me>/wip-…` branch with at least one save, click
      **Open pull request**. The PR is created and the browser lands on
      `/flushing-coin/pulls/:number`.
- [ ] As a second user (`test-vera` / write role), open `/flushing-coin/pulls/:number`
      and submit **Request changes** with a comment.
- [ ] Back as the author: edit + Save on the same head branch. Refresh the PR
      conversation and files pages; the new commits and diffs appear.
- [ ] Approve as `test-vera`. Merge as `chao` from the server-rendered PR page
      (admin gate runs requireAdminFresh).
- [ ] Close an unmerged PR through the typed API if the web close form is not
      present yet.

## 7. Issues
- [ ] Open `/flushing-coin/issues`; state, label, milestone, author, assignee,
      mentioned, search, and sort filters are visible.
- [ ] Open the issue → add a comment → comment appears.
- [ ] Close the issue. Verify it disappears from the open-state issues list and
      appears with `state=closed`.
- [ ] Use typed issue routes for create, label, milestone, dependency, and
      pinned-state checks until all those forms exist on the server-rendered
      issue pages.

## 8. Notifications
- [ ] Trigger a notification (be assigned to an issue, get a review request).
- [ ] Use `GET /api/v1/w/flushing-coin/notifications` to confirm the typed
      notification feed until the server-rendered notification page exists.
- [ ] `POST /api/v1/w/flushing-coin/notifications/read-all` zeros the unread
      feed.

## 9. Settings
- [ ] As admin, `/flushing-coin/settings`: change required approvals from 1 → 2 → save.
      Forgejo branch protection on `main` updates accordingly. Reverse it.
- [ ] `/account/settings`: change document theme and PR diff defaults. Reopen a
      reader page and PR files page to confirm those preferences apply.

## 10. Webhook reconciliation
- [ ] Edit a markdown file directly in Forgejo's UI (different content
      than what cosheaf last saw). Wait ~1s; cosheaf's file list and
      search update from the webhook.
- [ ] `pnpm cli workspace drift-check flushing-coin` reports `clean`.
- [ ] Stop cosheaf, edit another file in Forgejo, restart cosheaf → drift-check
      shows the missed file; `pnpm cli workspace reindex flushing-coin` brings
      it in sync; drift-check is clean again.

## 11. Read-only role
- [ ] Set a third user (`test-bob`) to `read` role via `/flushing-coin/settings`
      access controls or Forgejo collaborators. Sign in as test-bob.
- [ ] New/edit/save/merge affordances are hidden or forbidden. Reading files,
      issues, pull requests, and activity still works.

## Per-format expectations

| Path | coflat | forgejo-passthrough |
|---|---|---|
| File rendering | Coflat reader: math, `[@id]` citations, footnotes | Forgejo's `/markdown`: GFM + repo-context linkification |
| Backlinks panel | Populated from `[@id]` and `[text](path.md)` links | Empty (passthrough's extractLinks returns []) |
| Linter tab | Broken-ref rows if any | Empty |
| PR rich-diff view | Source-line-attributed side-by-side | Falls back to plain source diff |
| Editor | `@chaoxu/coflat` MarkdownEditor | Plain textarea |

Each section ~5 minutes; whole checklist runnable in ~30 min if everything
green. Anything red → file an issue with the failing step.
