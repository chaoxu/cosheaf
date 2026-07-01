import type { Config } from "./db.js";
import type Database from "better-sqlite3";
import type { Forgejo } from "./forgejo.js";
import { mergePullWithRetry } from "./forgejo.js";
import type { ForgejoPull } from "./forgejo-types.js";
import type { DocumentFormatId } from "../shared/document-format.js";
import type { User } from "./users.js";
import {
  ensureWorkspaceFile,
  lockedReindexWorkspaceFromForgejo,
  provisionWorkspace,
} from "./workspace-provisioning.js";
import {
  COFLAT_SHOWCASE_BIB,
  COFLAT_SHOWCASE_BIB_PATH,
  COFLAT_SHOWCASE_IMAGE,
  COFLAT_SHOWCASE_IMAGE_PATH,
  COFLAT_SHOWCASE_ISSUE_TITLE,
  COFLAT_SHOWCASE_PAGE_PATH,
  coflatFeatureShowcase,
} from "./seed-fixtures.js";

export const SEED_PROFILES = ["basic", "large-doc", "rendering", "review-flow", "all"] as const;
export type SeedProfile = (typeof SEED_PROFILES)[number];

export interface SeedOptions {
  user: string;
  password: string;
  owner: string;
  repo: string;
  workspaceName: string;
  defaultMdFormat: DocumentFormatId;
  profile: SeedProfile;
}

const RENDERING_FIXTURE_ISSUE_TITLE = "Rendering fixture: long Markdown issue";
const RENDERING_FIXTURE_PR_TITLE = "Rendering fixture: long Markdown PR";
const RENDERING_FIXTURE_BRANCH = "fixtures/rendering-markdown";
const RENDERING_FIXTURE_PATH = "notes/rendering-fixture.md";
const SIDE_BY_SIDE_FIXTURE_PR_TITLE = "Rendering fixture: side-by-side Markdown PR";
const SIDE_BY_SIDE_FIXTURE_BRANCH = "fixtures/side-by-side-rendering";
const SIDE_BY_SIDE_FIXTURE_PATH = "hello.md";
const MERGED_FIXTURE_PR_TITLE = "Rendering fixture: merged Markdown PR";
const MERGED_FIXTURE_BRANCH = "fixtures/merged-rendering-markdown";
const MERGED_FIXTURE_PATH = "notes/merged-rendering-fixture.md";

type SeedFile = { path: string; content: string | Buffer; message: string };

export function isSeedProfile(value: string): value is SeedProfile {
  return (SEED_PROFILES as readonly string[]).includes(value);
}

function profileIncludes(profile: SeedProfile, capability: "large-doc" | "rendering" | "review-flow"): boolean {
  if (profile === "all") return true;
  if (capability === "large-doc") return profile === "large-doc" || profile === "rendering" || profile === "review-flow";
  if (capability === "rendering") return profile === "rendering" || profile === "review-flow";
  return profile === "review-flow";
}

function renderingFixtureIssueBody(workspaceName: string): string {
  return [
    "## Purpose",
    "",
    `This seed issue exists so ${workspaceName} always has a long Markdown body for checking issue rendering, comments, references, and layout wrapping.`,
    "",
    "It intentionally includes multiple block types in one place:",
    "",
    "- a page reference to [@hello]",
    "- an issue-style reference like #1",
    "- a file-line reference like hello.md#L1-4",
    "- inline math $a^2 + b^2 = c^2$ and display math",
    "",
    "$$",
    "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
    "$$",
    "",
    "### Checklist",
    "",
    "- [ ] Headings keep a readable vertical rhythm.",
    "- [ ] Lists, checkboxes, and long paragraphs wrap without overlapping the sidebar.",
    "- [ ] Bare references become clickable where Cosheaf supports them.",
    "",
    "| Surface | What to inspect |",
    "| --- | --- |",
    "| Issue body | Long-form Markdown and math |",
    "| Issue sidebar | Truncated titles and selection state |",
    "| Browser back | Returning from issue detail to a file |",
    "",
    "> This quote is deliberately a little longer than usual, so the renderer has to handle multi-line blockquote wrapping rather than only a one-line sample.",
    "",
    "```ts",
    "export function seededRenderingFixture(): string {",
    '  return "issue markdown stays readable";',
    "}",
    "```",
  ].join("\n");
}

function renderingFixturePrBody(): string {
  return [
    "## Review focus",
    "",
    "This seeded PR gives the review UI a stable long-form description and a Markdown file diff.",
    "",
    "Please inspect:",
    "",
    "1. the PR header rendering",
    "2. rich diff rendering for the added Markdown file",
    "3. references such as [@hello], hello.md#L1-4, and #1",
    "",
    "### Notes",
    "",
    "- The branch is intentionally left open for manual review testing.",
    "- The body includes math: $e^{i\\pi} + 1 = 0$.",
    "- The changed file includes headings, tables, code fences, and long paragraphs.",
  ].join("\n");
}

function renderingFixturePage(opts: {
  workspaceName: string;
  id?: string;
  title?: string;
}): string {
  const id = opts.id ?? "rendering-fixture";
  const title = opts.title ?? "Rendering Fixture";
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "---",
    `# ${title}`,
    "",
    `This page is seeded on a pull-request branch for ${opts.workspaceName}. It is long enough to exercise the rich diff renderer and the editor's reader mode.`,
    "",
    "See [@hello] for the main seed page. This paragraph also mentions hello.md#L1-4 and #1 so bare-reference rewriting can be checked in review surfaces.",
    "",
    "## Mathematical block",
    "",
    "Inline math should render inside a sentence, for example $x^2 + y^2 = z^2$.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "## Table",
    "",
    "| Feature | Expected behavior |",
    "| --- | --- |",
    "| Headings | Maintain hierarchy |",
    "| Tables | Keep columns readable |",
    "| Code fences | Preserve monospace formatting |",
    "| References | Stay clickable where supported |",
    "",
    "## Code fence",
    "",
    "```ts",
    "type SeededSurface = \"issue\" | \"pull-request\" | \"diff\";",
    "",
    "export const seededSurface: SeededSurface = \"diff\";",
    "```",
    "",
    "## Long paragraph",
    "",
    "The renderer should handle a deliberately long paragraph without clipping or overlapping neighboring UI. This text is verbose on purpose: it gives the sidebar, review header, status bar, and scroll containers enough content to expose wrapping and overflow problems that a tiny fixture would miss.",
    "",
    "> A blockquote in the changed file helps verify quote styling in rich diff mode.",
    "",
  ].join("\n");
}

function sideBySideFixturePrBody(): string {
  return [
    "## Review focus",
    "",
    "This seeded PR modifies an existing Markdown page so the side-by-side rich diff has meaningful base and head panes.",
    "",
    "- Base side should show the original `hello.md` body.",
    "- Head side should show the updated long-form body.",
    "- References like [@hello], hello.md#L1-4, and #1 should render in the same reader style as issue and PR bodies.",
  ].join("\n");
}

function sideBySideFixturePage(workspaceName: string): string {
  return [
    "---",
    "id: hello",
    "title: Hello",
    "---",
    "# Hello",
    "",
    `This branch version of the ${workspaceName} hello page gives reviewers a real before/after comparison.`,
    "",
    "The paragraph is intentionally longer than the original seed. It should wrap with the same typography and spacing as the editor rich mode, including links such as [@hello], issue references such as #1, and path references such as hello.md#L1-4.",
    "",
    "## Side-by-side checks",
    "",
    "- The base pane should not be empty.",
    "- The head pane should show this checklist.",
    "- Tables and code blocks should keep the same visual language as the editor.",
    "",
    "| Pane | Expected content |",
    "| --- | --- |",
    "| base | original hello page |",
    "| head | updated rendering fixture page |",
    "",
    "```ts",
    "export const sideBySideFixture = true;",
    "```",
    "",
    "$$",
    "a^2 + b^2 = c^2",
    "$$",
    "",
  ].join("\n");
}

function samplePdfFixture(): Buffer {
  const stream = "BT /F1 18 Tf 36 90 Td (Cosheaf PDF preview fixture) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>\n",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\n",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream\n`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${body}endobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export async function seedWorkspace(args: {
  options: SeedOptions;
  db: Database.Database;
  forgejo: Forgejo;
  config: Config;
}): Promise<void> {
  const { options, db, forgejo, config } = args;
  const user: User = { username: options.user };
  const { workspace, createdRepo } = await provisionWorkspace(db, forgejo, config, {
    owner: options.owner,
    repo: options.repo,
    name: options.workspaceName,
    user,
    forgejoUsername: options.user,
    provisionVia: "admin",
    rollbackCreatedRepoOnLocalFailure: true,
    defaultMdFormat: options.defaultMdFormat,
  });
  console.log(`${createdRepo ? "created" : "ensured"} workspace ${workspace.slug}`);

  const files = seedFiles(options);
  for (const file of files) {
    const created = await ensureWorkspaceFile(forgejo, workspace.owner, workspace.repo, file);
    if (created) console.log(`created ${file.path}`);
  }
  await lockedReindexWorkspaceFromForgejo(db, forgejo, workspace);
  if (profileIncludes(options.profile, "large-doc")) {
    await ensureCoflatShowcaseIssue(forgejo, workspace.owner, workspace.repo, options.workspaceName);
  }
  if (profileIncludes(options.profile, "rendering")) {
    await ensureRenderingFixtures(forgejo, workspace.owner, workspace.repo, options.workspaceName, options.profile);
  }

  console.log(`seeded dev workspace: user=${options.user} workspace=${workspace.slug} profile=${options.profile}`);
}

function seedFiles(options: SeedOptions): SeedFile[] {
  const files: SeedFile[] = [
    {
      path: ".gitattributes",
      content: "*.md text eol=lf -text\n",
      message: "chore: lock byte-exactness for .md",
    },
    {
      path: "hello.md",
      content: [
        "---",
        "id: hello",
        "title: Hello",
        "---",
        "# Hello",
        "",
        `This is the default development page for ${options.workspaceName}.`,
        "",
        "Cross-file reference fixture: [@thm:coin-conservation].",
        "",
      ].join("\n"),
      message: "docs: add development hello page",
    },
    {
      path: "theory/cross-file-theorem.md",
      content: [
        "---",
        "id: cross-file-theorem",
        "title: Cross-file theorem fixture",
        "---",
        "# Cross-file theorem fixture",
        "",
        '::: {#thm:coin-conservation .theorem title="Coin Conservation"}',
        "A flushed coin stays accountable across file boundaries.",
        ":::",
        "",
      ].join("\n"),
      message: "docs: add cross-file theorem fixture",
    },
    {
      path: "notes/plain-text.txt",
      content: [
        "Cosheaf plain text fixture",
        "",
        "This file is intentionally not Markdown. It should appear in the file browser, render in a plain text preview, and use the text editor rather than the Coflat editor.",
        "",
      ].join("\n"),
      message: "docs: add plain text preview fixture",
    },
    {
      path: "docs/sample.pdf",
      content: samplePdfFixture(),
      message: "docs: add pdf preview fixture",
    },
  ];
  if (profileIncludes(options.profile, "large-doc")) {
    files.push(
      {
        path: COFLAT_SHOWCASE_PAGE_PATH,
        content: coflatFeatureShowcase(options.workspaceName),
        message: "docs: add coflat feature showcase",
      },
      {
        path: COFLAT_SHOWCASE_BIB_PATH,
        content: COFLAT_SHOWCASE_BIB,
        message: "docs: add coflat showcase bibliography",
      },
      {
        path: COFLAT_SHOWCASE_IMAGE_PATH,
        content: COFLAT_SHOWCASE_IMAGE,
        message: "docs: add coflat showcase image",
      },
    );
  }
  return files;
}

async function ensureCoflatShowcaseIssue(
  forgejo: Forgejo,
  owner: string,
  repo: string,
  workspaceName: string,
): Promise<void> {
  await ensureIssue(forgejo, owner, repo, COFLAT_SHOWCASE_ISSUE_TITLE, coflatFeatureShowcase(workspaceName));
}

async function ensureRenderingFixtures(
  forgejo: Forgejo,
  owner: string,
  repo: string,
  workspaceName: string,
  profile: SeedProfile,
): Promise<void> {
  await ensureIssue(forgejo, owner, repo, RENDERING_FIXTURE_ISSUE_TITLE, renderingFixtureIssueBody(workspaceName));
  if (!profileIncludes(profile, "review-flow")) return;

  const pulls = await forgejo.listPulls(owner, repo, "all");
  await ensureFixturePull(forgejo, owner, repo, pulls, {
    branch: RENDERING_FIXTURE_BRANCH,
    path: RENDERING_FIXTURE_PATH,
    content: renderingFixturePage({ workspaceName }),
    title: RENDERING_FIXTURE_PR_TITLE,
    body: renderingFixturePrBody(),
    createMessage: "docs: add rendering fixture",
  });
  await ensureFixturePull(forgejo, owner, repo, pulls, {
    branch: SIDE_BY_SIDE_FIXTURE_BRANCH,
    path: SIDE_BY_SIDE_FIXTURE_PATH,
    content: sideBySideFixturePage(workspaceName),
    title: SIDE_BY_SIDE_FIXTURE_PR_TITLE,
    body: sideBySideFixturePrBody(),
    createMessage: "docs: add side-by-side rendering fixture",
    updateMessage: "docs: update side-by-side rendering fixture",
    updateExisting: true,
  });
  await ensureFixturePull(forgejo, owner, repo, pulls, {
    branch: MERGED_FIXTURE_BRANCH,
    path: MERGED_FIXTURE_PATH,
    content: renderingFixturePage({
      workspaceName,
      id: "merged-rendering-fixture",
      title: "Merged Rendering Fixture",
    }),
    title: MERGED_FIXTURE_PR_TITLE,
    body: "## Merged rendering fixture\n\nThis PR is merged by the seed so the workspace has at least one completed review-flow artifact.",
    createMessage: "docs: add merged rendering fixture",
    merge: true,
  });
}

async function ensureIssue(
  forgejo: Forgejo,
  owner: string,
  repo: string,
  title: string,
  body: string,
): Promise<void> {
  const issues = await forgejo.listIssues(owner, repo, {
    state: "all",
    limit: 50,
    q: title,
  });
  if (issues.some((issue) => issue.title === title)) {
    console.log(`${title} already exists`);
    return;
  }
  await forgejo.createIssue(owner, repo, { title, body });
  console.log(`created ${title}`);
}

async function ensureFixturePull(
  forgejo: Forgejo,
  owner: string,
  repo: string,
  pulls: readonly ForgejoPull[],
  fixture: {
    branch: string;
    path: string;
    content: string;
    title: string;
    body: string;
    createMessage: string;
    updateMessage?: string;
    updateExisting?: boolean;
    merge?: boolean;
  },
): Promise<void> {
  const branch = await forgejo.getBranch(owner, repo, fixture.branch);
  if (!branch) {
    await forgejo.createBranch(owner, repo, {
      newBranchName: fixture.branch,
      oldBranchName: "main",
    });
    console.log(`created branch ${fixture.branch}`);
  }
  const meta = await forgejo.getFileMeta(owner, repo, fixture.branch, fixture.path);
  const current =
    meta && fixture.updateExisting
      ? await forgejo.getRawFile(owner, repo, fixture.branch, fixture.path)
      : null;
  if (!meta || (fixture.updateExisting && current !== fixture.content)) {
    await forgejo.putFile(owner, repo, {
      branch: fixture.branch,
      path: fixture.path,
      content: fixture.content,
      sha: meta?.sha,
      message: meta ? fixture.updateMessage ?? fixture.createMessage : fixture.createMessage,
    });
    console.log(`${meta ? "updated" : "created"} ${fixture.path} on ${fixture.branch}`);
  }

  let pr = pulls.find((pull) => pull.title === fixture.title || pull.head.ref === fixture.branch);
  if (!pr) {
    pr = await forgejo.createPull(owner, repo, {
      head: fixture.branch,
      base: "main",
      title: fixture.title,
      body: fixture.body,
    });
    console.log(`created ${fixture.title}`);
  } else {
    console.log(`${fixture.title} already exists`);
  }
  if (fixture.merge && !pr.merged) {
    await mergePullWithRetry(
      () => forgejo.mergePull(owner, repo, pr.number, {
        Do: "squash",
        message: "docs: merge rendering fixture",
        force: true,
      }),
      { attempts: 5, delayMs: (attempt) => attempt * 1000 },
    );
    console.log(`merged ${fixture.title}`);
  }
}
