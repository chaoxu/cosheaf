import type { ForgejoBranch, ForgejoTreeEntry } from "../forgejo-types.js";
import { branchIcon, chevronIcon } from "./icons.js";
import { defaultFileLinkAttrs } from "./web-file-links.js";
import { emptyHtml, html, type Html } from "./web-html.js";
import { repoHref, urlPath } from "./web-context.js";

// Nested, collapsible branch file tree for the left sidebar on /files pages
// (#119). Built from the flat blob list already fetched for the page — no extra
// round-trip. Directories are native <details> (collapsible like any file
// explorer); the active file is highlighted and its ancestor folders auto-open.
interface FileTreeNode {
  dirs: Map<string, FileTreeNode>;
  files: Array<{ name: string; path: string }>;
}

function buildFileTree(files: readonly ForgejoTreeEntry[]): FileTreeNode {
  const root: FileTreeNode = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], path: file.path });
  }
  return root;
}

function renderFileTreeLevel(
  node: FileTreeNode,
  prefix: string,
  owner: string,
  repo: string,
  branch: string,
  activeRel: string | null,
  titles: Map<string, string> | undefined,
  user: string | undefined,
  editByDefault: boolean,
): Html {
  const dirs = [...node.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => {
      const dirPath = prefix ? `${prefix}/${name}` : name;
      const open = activeRel === dirPath || (activeRel?.startsWith(`${dirPath}/`) ?? false);
      return html`<details class="ftree-dir"${open ? " open" : ""}>
        <summary>${chevronIcon({ size: 11, class: "disclosure-chevron" })}${name}</summary>
        <div class="ftree-children">${renderFileTreeLevel(child, dirPath, owner, repo, branch, activeRel, titles, user, editByDefault)}</div>
      </details>`;
    });
  const fileRows = node.files.map((file) => {
    // Titled Markdown leaves render both labels; the user's file-label
    // preference chooses whether the visible label is the indexed Markdown
    // title or the storage filename. `title=` keeps the filename on hover.
    const title = file.path.endsWith(".md") ? titles?.get(file.path) : undefined;
    const label = title
      ? html`<span class="ftree-title">${title}</span><span class="ftree-name">${file.name}</span>`
      : file.name;
    return html`<a class="ftree-file${file.path === activeRel ? " active" : ""}" ${defaultFileLinkAttrs(owner, repo, user, branch, file.path, editByDefault)} title="${file.name}">${label}</a>`;
  });
  return html`${dirs}${fileRows}`;
}

// Branch indicator + switcher in the file-tree header: shows the current branch
// and, when more than one exists, a <select> that navigates to that branch's
// files. An empty `branches` (the edit page) renders just the label — no
// navigate-away mid-edit. cosheaf-select.js styles the select and fires the
// native `change` the inline handler listens for; with JS off the native select
// still navigates.
function branchSwitcher(owner: string, repo: string, branch: string, branches: readonly ForgejoBranch[]): Html {
  const names = branches.map((b) => b.name);
  if (!names.includes(branch)) names.unshift(branch);
  // The switcher carries its own external icon span (the #185 canonical fix):
  // it must show even in the single-branch case below, which renders no <select>
  // for the widget to enhance, and its option values are URLs, not branch names.
  // So it does NOT use the form selects' data-option-icon="branch" hook (#187) —
  // that would render a second icon on the enhanced trigger.
  const icon = html`<span class="ftree-branch-icon">${branchIcon({ size: 13 })}</span>`;
  if (names.length <= 1) {
    return html`<span class="ftree-branch">${icon}<span class="ftree-branch-name">${branch}</span></span>`;
  }
  return html`<span class="ftree-branch">${icon}<select class="ftree-branch-select" aria-label="Switch branch" onchange="if(this.value)location.assign(this.value)">${names.map(
    (name) => html`<option value="${`${repoHref(owner, repo, "/src/branch")}/${urlPath(name)}`}"${name === branch ? " selected" : ""}>${name}</option>`,
  )}</select></span>`;
}

function fileTreeSidebar(
  owner: string,
  repo: string,
  branch: string,
  files: readonly ForgejoTreeEntry[],
  activeRel: string | null,
  titles: Map<string, string> | undefined,
  branches: readonly ForgejoBranch[],
  user?: string,
  editByDefault = false,
  displayBranch = branch,
): Html {
  if (files.length === 0) return emptyHtml;
  return html`<nav class="file-tree" aria-label="Files">
    <div class="file-tree-head">${branchSwitcher(owner, repo, displayBranch, branches)}<span class="file-tree-actions-slot"></span></div>
    ${renderFileTreeLevel(buildFileTree(files), "", owner, repo, branch, activeRel, titles, user, editByDefault)}
  </nav>`;
}

// Branch file tree content for the left sidebar. `titles` is the workspace
// page-title map (main branch only — the index tracks main); leaves render
// titles where present (#168). `branches` feeds the header switcher (empty =
// label only).
export function fileTreePanel(
  owner: string,
  repo: string,
  branch: string,
  files: readonly ForgejoTreeEntry[],
  activeRel: string | null,
  titles?: Map<string, string>,
  branches: readonly ForgejoBranch[] = [],
  user?: string,
  editByDefault = false,
  displayBranch = branch,
): Html {
  return fileTreeSidebar(owner, repo, branch, files, activeRel, titles, branches, user, editByDefault, displayBranch);
}
