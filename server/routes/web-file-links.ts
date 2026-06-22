import { userBranchPrefix } from "../../shared/conventions.js";
import { isEditableTextFile } from "../../shared/file-kind.js";
import { repoHref, urlPath } from "./web-context.js";
import { html, type Html } from "./web-html.js";

export function editBranchFor(username: string, requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  return trimmed && trimmed !== "main" ? trimmed : `user/${username}/web-edit`;
}

export function rawFileHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/raw/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

export function editHref(owner: string, repo: string, user: string, branch: string, rel?: string): string {
  const base = `${repoHref(owner, repo, "/_edit")}?branch=${encodeURIComponent(editBranchFor(user, branch))}`;
  return rel ? `${base}&path=${encodeURIComponent(rel)}` : base;
}

export function readHref(owner: string, repo: string, branch: string, rel: string): string {
  return `${repoHref(owner, repo, "/src/branch")}/${urlPath(branch)}/${urlPath(rel)}`;
}

export function defaultFileLinkAttrs(owner: string, repo: string, user: string | undefined, branch: string, rel: string, canEdit: boolean): Html {
  const read = readHref(owner, repo, branch, rel);
  if (!canEdit || !user || !isEditableTextFile(rel)) return html`href="${read}"`;
  const edit = editHref(owner, repo, user, branch, rel);
  return html`href="${edit}" data-file-open-link data-edit-href="${edit}" data-read-href="${read}"`;
}

// "New file" as a name-it-first control: a GET form whose `path` routes to
// /_edit, which picks the Markdown or plain-text editor from the extension — so
// you can create a `.bib` (or .csv, .tex, …), not only `.md`. Blank submits as
// `new.md`, preserving the old one-click create-a-page behavior.
export function newFileControl(owner: string, repo: string, user: string, branch: string): Html {
  return html`<form class="newfile" action="${repoHref(owner, repo, "/_edit")}" method="get">
    <input type="hidden" name="branch" value="${editBranchFor(user, branch)}">
    <input class="newfile-path" name="path" placeholder="new.md" aria-label="New file name" autocomplete="off" spellcheck="false">
    <button class="button" type="submit">New file</button>
  </form>`;
}

export function userDefaultEditBranch(username: string): string {
  return `${userBranchPrefix(username)}web-edit`;
}
