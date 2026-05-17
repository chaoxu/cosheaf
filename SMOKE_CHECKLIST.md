# Manual smoke checklist

Run after `pnpm setup:dev` (or after any non-trivial change). Walks every
user-visible path. Per-format expectations are noted where they differ.

The seeded workspace is **Flushing Coin** (`flushing-coin`), default format
`coflat`. To smoke the passthrough format too, create a second workspace
with `default_md_format = forgejo-passthrough` via the settings panel.

## 1. Login + workspace switch
- [ ] `/` → login form. Sign in as `chao` / `Cosheaf123!`.
- [ ] Workspace tile **Flushing Coin** is listed; click it.
- [ ] Sidebar shows the workspace name and the **Files** tab is active.

## 2. File tree, read, write
- [ ] Sidebar shows `hello.md` and `README.md` at minimum.
- [ ] Open `hello.md` — editor loads with body content visible.
- [ ] Open a file in a nested directory (e.g. `notes/foo.md` if seeded;
      otherwise create one via "+ New file" → path `notes/foo.md`).
- [ ] Edit the body, click **Save** — toast says "saved on `user/<name>/wip-…`".
- [ ] Save again — pushes more commits to the same branch (no new branch).

## 3. Asset upload
- [ ] Drag an image into the editor (or paste). Image appears in the doc as
      `![](assets/...)`.
- [ ] Save. The asset file is committed alongside the markdown.

## 4. Search, backlinks, validation
- [ ] Search box: query a known word from `hello.md` → result shows the file
      with a snippet.
- [ ] Backlinks panel (coflat workspace only) lists incoming refs for a page
      that has them.
- [ ] Linter tab — for a coflat workspace, broken-reference rows appear if
      any; for a passthrough workspace the tab is empty.

## 5. Branches
- [ ] **Files** → "+ New file" or save a new edit → creates a `user/<me>/wip-…`
      branch and an `active-branch-name` chip in the editor.
- [ ] Switch back to **main** via the branch switcher; chip disappears.
- [ ] `pnpm cli workspace inspect flushing-coin` lists the branch.
- [ ] Delete the branch via Forgejo's UI (or `tea branches delete`); refresh
      the SPA → branch disappears from the "Mine" list.

## 6. Pull-request lifecycle
- [ ] On a `user/<me>/wip-…` branch with at least one save, click
      **Open pull request**. PR is created; the editor still shows the same
      branch chip (so further saves push more commits, #26).
- [ ] As a second user (`vera` / set role to write), open the inbox → review
      the PR → click **Request changes** with a comment.
- [ ] Back as the author: edit + Save → asserts the save pushed to the SAME
      head ref. Switch back to the PR view — new commits appear.
- [ ] Approve as `vera`. Merge as `chao` (admin gate runs requireAdminFresh).
- [ ] Close (without merge) a different PR to verify the close path works.

## 7. Issues
- [ ] Inbox → "+ Issue" → fill title/body → create. The new issue appears in
      both Forgejo's UI and cosheaf's inbox.
- [ ] Open the issue → add a comment → comment appears.
- [ ] Add a dependency (issue number) → backlinks panel reflects it.
- [ ] Pin the issue (admin only) → "Pinned" badge appears.
- [ ] Close the issue. Verify it disappears from the open-state inbox view.

## 8. Notifications
- [ ] Trigger a notification (be assigned to an issue, get a review request).
- [ ] Inbox tab shows the notification; click → navigates to target.
- [ ] **Mark all read** → unread counter zeros.

## 9. Settings
- [ ] As admin, settings panel: change `min_approvals` from 1 → 2 → save.
      Forgejo branch protection on `main` updates accordingly. Reverse it.
- [ ] Change `default_md_format` to the other format → reindex runs →
      backlinks panel / linter behavior changes to match the new format.

## 10. Webhook reconciliation
- [ ] Edit a markdown file directly in Forgejo's UI (different content
      than what cosheaf last saw). Wait ~1s; cosheaf's file list and
      search update from the webhook.
- [ ] `pnpm cli workspace drift-check flushing-coin` reports `clean`.
- [ ] Stop cosheaf, edit another file in Forgejo, restart cosheaf → drift-check
      shows the missed file; `pnpm cli workspace reindex flushing-coin` brings
      it in sync; drift-check is clean again.

## 11. Read-only role
- [ ] Set a third user (`bob`) to `read` role on the workspace via Forgejo's
      collaborators UI. Sign in as bob.
- [ ] Sidebar shows the **read-only** badge.
- [ ] "+ New file", "+ Issue", **Save**, and **Open pull request** affordances
      are hidden. Everything else (reading, viewing PRs, searching) works.

## Per-format expectations

| Path | coflat | forgejo-passthrough |
|---|---|---|
| File rendering | Coflat reader: math, `[@id]` citations, footnotes | Forgejo's `/markdown`: GFM + repo-context linkification |
| Backlinks panel | Populated from `[@id]` and `[text](path.md)` links | Empty (passthrough's extractLinks returns []) |
| Linter tab | Broken-ref rows if any | Empty |
| PR rich-diff view | Source-line-attributed side-by-side | Falls back to plain source diff |
| Editor | `@chaoxu/coflat-editor` MarkdownEditor | Plain textarea |

Each section ~5 minutes; whole checklist runnable in ~30 min if everything
green. Anything red → file an issue with the failing step.
