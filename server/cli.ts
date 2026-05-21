import { createInterface } from "node:readline/promises";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import repl from "node:repl";
import { stdin, stdout } from "node:process";
import { Command, InvalidArgumentError } from "commander";
import { WORKSPACE_SLUG_RE } from "../shared/conventions.js";
import { getDb, loadConfig } from "./db.js";
import { Forgejo, ForgejoError } from "./forgejo.js";
import { ROLES, type Role } from "../shared/roles.js";
import {
  ensureWorkspaceFile,
  provisionWorkspace,
  readWorkspaceFormatFromTopics,
  reindexWorkspaceFromForgejo,
} from "./workspace-provisioning.js";
import { deleteSidecarForWorkspace } from "./workspace-cleanup.js";
import {
  COFLAT_FORMAT_ID,
  DEFAULT_DOCUMENT_FORMAT_ID,
  documentFormatFromTopics,
  isDocumentFormatId,
  isFormatTopic,
  type DocumentFormatId,
} from "../shared/document-format.js";
import {
  COFLAT_SHOWCASE_BIB,
  COFLAT_SHOWCASE_BIB_PATH,
  COFLAT_SHOWCASE_IMAGE,
  COFLAT_SHOWCASE_IMAGE_PATH,
  COFLAT_SHOWCASE_ISSUE_TITLE,
  COFLAT_SHOWCASE_PAGE_PATH,
  coflatFeatureShowcase,
} from "./seed-fixtures.js";

interface SeedOptions {
  user: string;
  password: string;
  workspace: string;
  workspaceName: string;
  defaultMdFormat: DocumentFormatId;
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

function renderingFixturePage(workspaceName: string): string {
  return [
    "---",
    "id: rendering-fixture",
    "title: Rendering Fixture",
    "---",
    "# Rendering Fixture",
    "",
    `This page is seeded on a pull-request branch for ${workspaceName}. It is long enough to exercise the rich diff renderer and the editor's reader mode.`,
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

async function readPassword(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  stdout.write(prompt);
  return new Promise<string>((resolve) => {
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdout.write("\n");
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          resolve(buf);
          return;
        }
        if (ch === "") {
          stdin.setRawMode?.(false);
          stdin.pause();
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function ctx() {
  const config = loadConfig();
  const db = getDb(config);
  // CLI runs out-of-band of any HTTP request; use the admin token. This is
  // the one entry-point that's allowed to (the runtime request path never
  // touches the admin token — it uses per-user PATs).
  const forgejo = new Forgejo({ baseUrl: config.forgejoUrl, token: config.forgejoToken });
  return { config, db, forgejo };
}

interface CliWorkspaceRow {
  slug: string;
  defaultMdFormat: DocumentFormatId;
}

// Resolve a workspace by slug and hand the caller everything it needs.
// Exits 1 with a uniform "workspace 'x' not found" message on miss so callers
// don't repeat the same five lines.
async function withWorkspace<T>(
  slug: string,
  fn: (args: {
    config: ReturnType<typeof loadConfig>;
    db: ReturnType<typeof getDb>;
    forgejo: Forgejo;
    workspace: CliWorkspaceRow;
  }) => Promise<T> | T,
): Promise<T> {
  const { config, db, forgejo } = ctx();
  // Workspaces are identified solely by their Forgejo repo. The CLI
  // verifies existence against Forgejo and reads the markdown format from
  // the repo's topics.
  const repo = await forgejo.getRepo(config.forgejoOwner, slug);
  if (!repo) {
    console.error(`workspace '${slug}' not found`);
    process.exit(1);
  }
  const ws: CliWorkspaceRow = {
    slug,
    defaultMdFormat: await readWorkspaceFormatFromTopics(forgejo, config.forgejoOwner, slug),
  };
  return fn({ config, db, forgejo, workspace: ws });
}

function valueFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const value = args[i + 1];
      return value && !value.startsWith("-") ? value : undefined;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function parseSeedOptions(args: string[]): SeedOptions {
  const user = valueFlag(args, "--user");
  const password = valueFlag(args, "--password");
  const workspace = valueFlag(args, "--workspace");
  const workspaceName = valueFlag(args, "--workspace-name") ?? workspace;
  const formatRaw = valueFlag(args, "--default-md-format") ?? DEFAULT_DOCUMENT_FORMAT_ID;
  const missing = [
    ["--user", user],
    ["--password", password],
    ["--workspace", workspace],
    ["--workspace-name", workspaceName],
  ]
    .filter(([, value]) => !value)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(`seed requires ${missing.join(", ")}`);
  }
  if (!WORKSPACE_SLUG_RE.test(workspace ?? "")) {
    throw new Error(`workspace must match ${WORKSPACE_SLUG_RE}`);
  }
  if (!isDocumentFormatId(formatRaw)) {
    throw new Error(`--default-md-format must be a known DocumentFormatId, got: ${formatRaw}`);
  }
  return {
    user: user as string,
    password: password as string,
    workspace: workspace as string,
    workspaceName: workspaceName as string,
    defaultMdFormat: formatRaw,
  };
}

// Create the Forgejo account if absent. Users live entirely on Forgejo;
// the password set here is the only password the user has — they type it
// at cosheaf's login form, cosheaf exchanges it for a PAT, and the SPA
// stores the PAT.
async function ensureForgejoUser(
  username: string,
  password: string,
): Promise<void> {
  const { forgejo } = ctx();
  const fjExisting = await forgejo.getUserByName(username);
  if (!fjExisting) {
    await forgejo.createUser({
      username,
      email: `${username}@cosheaf.local`,
      password,
      must_change_password: false,
    });
    console.log(`created forgejo user ${username}`);
  } else {
    console.log(`forgejo user ${username} already exists (password unchanged)`);
  }
}

async function userAdd(username: string): Promise<void> {
  const password = await readPassword(`forgejo password for ${username}: `);
  if (!password) {
    console.error("password required");
    process.exit(1);
  }
  await ensureForgejoUser(username, password);
}

async function seed(args: string[]): Promise<void> {
  const options = parseSeedOptions(args);
  await ensureForgejoUser(options.user, options.password);

  const { config, db, forgejo } = ctx();
  const user = { username: options.user };
  const { workspace, createdRepo } = await provisionWorkspace(db, forgejo, config, {
    slug: options.workspace,
    name: options.workspaceName,
    user,
    forgejoUsername: options.user,
    allowExistingLocal: true,
    defaultMdFormat: options.defaultMdFormat,
  });
  console.log(`${createdRepo ? "created" : "ensured"} workspace ${options.workspace}`);

  const files = [
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
      ].join("\n"),
      message: "docs: add development hello page",
    },
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
  ];

  for (const file of files) {
    const created = await ensureWorkspaceFile(forgejo, config, workspace.slug, file);
    if (created) console.log(`created ${file.path}`);
  }
  await reindexWorkspaceFromForgejo(db, forgejo, config, workspace);
  await ensureRenderingFixtures(forgejo, config, workspace.slug, options.workspaceName);

  console.log(`seeded dev workspace: user=${options.user} workspace=${options.workspace}`);
}

async function ensureRenderingFixtures(
  forgejo: Forgejo,
  config: ReturnType<typeof loadConfig>,
  repo: string,
  workspaceName: string,
): Promise<void> {
  const issues = await forgejo.listIssues(config.forgejoOwner, repo, {
    state: "all",
    limit: 50,
    q: RENDERING_FIXTURE_ISSUE_TITLE,
  });
  if (issues.some((issue) => issue.title === RENDERING_FIXTURE_ISSUE_TITLE)) {
    console.log("rendering fixture issue already exists");
  } else {
    await forgejo.createIssue(config.forgejoOwner, repo, {
      title: RENDERING_FIXTURE_ISSUE_TITLE,
      body: renderingFixtureIssueBody(workspaceName),
    });
    console.log("created rendering fixture issue");
  }

  const showcaseIssues = await forgejo.listIssues(config.forgejoOwner, repo, {
    state: "all",
    limit: 50,
    q: COFLAT_SHOWCASE_ISSUE_TITLE,
  });
  if (showcaseIssues.some((issue) => issue.title === COFLAT_SHOWCASE_ISSUE_TITLE)) {
    console.log("coflat showcase issue already exists");
  } else {
    await forgejo.createIssue(config.forgejoOwner, repo, {
      title: COFLAT_SHOWCASE_ISSUE_TITLE,
      body: coflatFeatureShowcase(workspaceName),
    });
    console.log("created coflat showcase issue");
  }

  const branch = await forgejo.getBranch(config.forgejoOwner, repo, RENDERING_FIXTURE_BRANCH);
  if (!branch) {
    await forgejo.createBranch(config.forgejoOwner, repo, {
      newBranchName: RENDERING_FIXTURE_BRANCH,
      oldBranchName: "main",
    });
    console.log(`created branch ${RENDERING_FIXTURE_BRANCH}`);
  }

  const page = renderingFixturePage(workspaceName);
  const existingFile = await forgejo.getFileMeta(
    config.forgejoOwner,
    repo,
    RENDERING_FIXTURE_BRANCH,
    RENDERING_FIXTURE_PATH,
  );
  if (!existingFile) {
    await forgejo.putFile(config.forgejoOwner, repo, {
      branch: RENDERING_FIXTURE_BRANCH,
      path: RENDERING_FIXTURE_PATH,
      content: page,
      message: "docs: add rendering fixture",
    });
    console.log(`created ${RENDERING_FIXTURE_PATH} on ${RENDERING_FIXTURE_BRANCH}`);
  }

  const pulls = await forgejo.listPulls(config.forgejoOwner, repo, "all");
  if (pulls.some((pull) => pull.title === RENDERING_FIXTURE_PR_TITLE || pull.head.ref === RENDERING_FIXTURE_BRANCH)) {
    console.log("rendering fixture PR already exists");
  } else {
    await forgejo.createPull(config.forgejoOwner, repo, {
      head: RENDERING_FIXTURE_BRANCH,
      base: "main",
      title: RENDERING_FIXTURE_PR_TITLE,
      body: renderingFixturePrBody(),
    });
    console.log("created rendering fixture PR");
  }

  await ensureSideBySideRenderingFixture(forgejo, config, repo, workspaceName, pulls);
  await ensureMergedRenderingFixture(forgejo, config, repo, workspaceName, pulls);
}

async function ensureSideBySideRenderingFixture(
  forgejo: Forgejo,
  config: ReturnType<typeof loadConfig>,
  repo: string,
  workspaceName: string,
  pulls: Awaited<ReturnType<Forgejo["listPulls"]>>,
): Promise<void> {
  const branch = await forgejo.getBranch(config.forgejoOwner, repo, SIDE_BY_SIDE_FIXTURE_BRANCH);
  if (!branch) {
    await forgejo.createBranch(config.forgejoOwner, repo, {
      newBranchName: SIDE_BY_SIDE_FIXTURE_BRANCH,
      oldBranchName: "main",
    });
    console.log(`created branch ${SIDE_BY_SIDE_FIXTURE_BRANCH}`);
  }
  const content = sideBySideFixturePage(workspaceName);
  const meta = await forgejo.getFileMeta(
    config.forgejoOwner,
    repo,
    SIDE_BY_SIDE_FIXTURE_BRANCH,
    SIDE_BY_SIDE_FIXTURE_PATH,
  );
  const current = meta
    ? await forgejo.getRawFile(
        config.forgejoOwner,
        repo,
        SIDE_BY_SIDE_FIXTURE_BRANCH,
        SIDE_BY_SIDE_FIXTURE_PATH,
      )
    : null;
  if (current !== content) {
    await forgejo.putFile(config.forgejoOwner, repo, {
      branch: SIDE_BY_SIDE_FIXTURE_BRANCH,
      path: SIDE_BY_SIDE_FIXTURE_PATH,
      content,
      sha: meta?.sha,
      message: meta
        ? "docs: update side-by-side rendering fixture"
        : "docs: add side-by-side rendering fixture",
    });
    console.log(`${meta ? "updated" : "created"} ${SIDE_BY_SIDE_FIXTURE_PATH} on ${SIDE_BY_SIDE_FIXTURE_BRANCH}`);
  }
  if (pulls.some((pull) => pull.title === SIDE_BY_SIDE_FIXTURE_PR_TITLE || pull.head.ref === SIDE_BY_SIDE_FIXTURE_BRANCH)) {
    console.log("side-by-side rendering fixture PR already exists");
    return;
  }
  await forgejo.createPull(config.forgejoOwner, repo, {
    head: SIDE_BY_SIDE_FIXTURE_BRANCH,
    base: "main",
    title: SIDE_BY_SIDE_FIXTURE_PR_TITLE,
    body: sideBySideFixturePrBody(),
  });
  console.log("created side-by-side rendering fixture PR");
}

async function mergePullWithRetry(
  forgejo: Forgejo,
  config: ReturnType<typeof loadConfig>,
  repo: string,
  index: number,
): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await forgejo.mergePull(config.forgejoOwner, repo, index, {
        Do: "squash",
        message: "docs: merge rendering fixture",
        force: true,
      });
      return;
    } catch (err) {
      const isMergeabilityLag =
        err instanceof ForgejoError &&
        err.status === 405 &&
        err.bodyText.toLowerCase().includes("try again later");
      if (!isMergeabilityLag || attempt === attempts) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

async function ensureMergedRenderingFixture(
  forgejo: Forgejo,
  config: ReturnType<typeof loadConfig>,
  repo: string,
  workspaceName: string,
  pulls: Awaited<ReturnType<Forgejo["listPulls"]>>,
): Promise<void> {
  const existing = pulls.find((pull) => pull.title === MERGED_FIXTURE_PR_TITLE || pull.head.ref === MERGED_FIXTURE_BRANCH);
  if (existing?.merged) {
    console.log("merged rendering fixture PR already exists");
    return;
  }
  const branch = await forgejo.getBranch(config.forgejoOwner, repo, MERGED_FIXTURE_BRANCH);
  if (!branch) {
    await forgejo.createBranch(config.forgejoOwner, repo, {
      newBranchName: MERGED_FIXTURE_BRANCH,
      oldBranchName: "main",
    });
    console.log(`created branch ${MERGED_FIXTURE_BRANCH}`);
  }
  const mergedContent = renderingFixturePage(workspaceName)
    .replace("id: rendering-fixture", "id: merged-rendering-fixture")
    .replace("title: Rendering Fixture", "title: Merged Rendering Fixture");
  const existingFile = await forgejo.getFileMeta(
    config.forgejoOwner,
    repo,
    MERGED_FIXTURE_BRANCH,
    MERGED_FIXTURE_PATH,
  );
  if (!existingFile) {
    await forgejo.putFile(config.forgejoOwner, repo, {
      branch: MERGED_FIXTURE_BRANCH,
      path: MERGED_FIXTURE_PATH,
      content: mergedContent,
      message: "docs: add merged rendering fixture",
    });
    console.log(`created ${MERGED_FIXTURE_PATH} on ${MERGED_FIXTURE_BRANCH}`);
  }
  let pr = existing;
  if (!pr) {
    pr = await forgejo.createPull(config.forgejoOwner, repo, {
      head: MERGED_FIXTURE_BRANCH,
      base: "main",
      title: MERGED_FIXTURE_PR_TITLE,
      body: "## Merged rendering fixture\n\nThis PR is merged by the seed so the workspace has at least one completed review-flow artifact.",
    });
    console.log("created merged rendering fixture PR");
  }
  if (!pr.merged) {
    await mergePullWithRetry(forgejo, config, repo, pr.number);
    console.log("merged rendering fixture PR");
  }
}

async function workspaceRm(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ db, forgejo, config, workspace: ws }) => {
    try {
      await forgejo.deleteRepo(config.forgejoOwner, ws.slug);
    } catch (err) {
      if (!(err instanceof ForgejoError && err.status === 404)) {
        console.error(`forgejo deleteRepo failed: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    deleteSidecarForWorkspace(db, ws.slug);
    console.log(`deleted workspace ${slug} (forgejo repo + sidecar)`);
  });
}

async function workspaceReindex(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ db, forgejo, config, workspace: ws }) => {
    const count = await reindexWorkspaceFromForgejo(db, forgejo, config, ws);
    console.log(`reindexed ${count} markdown file${count === 1 ? "" : "s"} in workspace ${slug}`);
  });
}

async function workspaceMember(slug: string, username: string, role: Role): Promise<void> {
  await withWorkspace(slug, async ({ forgejo, config, workspace: ws }) => {
    // Forgejo's addCollaborator API returns 404 if the user doesn't exist
    // on Forgejo, which is the only "user" notion cosheaf has.
    await forgejo.addCollaborator(config.forgejoOwner, ws.slug, username, role);
    // Keep the branch-protection push whitelist in sync. Admin can direct-push;
    // write/read users can't. Adjust on every change so demotion takes effect.
    const bp = await forgejo.getBranchProtection(config.forgejoOwner, ws.slug, "main");
    const current = (bp as unknown as { push_whitelist_usernames?: string[] } | null)?.push_whitelist_usernames ?? [];
    const onList = current.includes(username);
    if (role === "admin" && !onList) {
      await forgejo.patchBranchProtectionPushWhitelist(config.forgejoOwner, ws.slug, "main", [...current, username]);
    } else if (role !== "admin" && onList) {
      await forgejo.patchBranchProtectionPushWhitelist(
        config.forgejoOwner,
        ws.slug,
        "main",
        current.filter((u) => u !== username),
      );
    }
    console.log(`set ${username} as ${role} in workspace ${slug}`);
  });
}

// --------------------------------- doctor ---------------------------------

type CheckStatus = "ok" | "fail" | "warn";
interface CheckResult { name: string; status: CheckStatus; detail: string }

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, status: "ok", detail };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

async function checkWarn(name: string, fn: () => Promise<{ status: "ok" | "warn"; detail: string }>): Promise<CheckResult> {
  try {
    const r = await fn();
    return { name, status: r.status, detail: r.detail };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

async function doctor(): Promise<void> {
  const { config, db, forgejo } = ctx();
  const results: CheckResult[] = [];

  results.push(
    await check("forgejo reachable", async () => {
      // Some Forgejo deployments require auth even on /version, so send the
      // admin token. We'll check admin-scope separately below.
      const r = await fetch(`${config.forgejoUrl}/api/v1/version`, {
        headers: { authorization: `token ${config.forgejoToken}` },
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${config.forgejoUrl}`);
      const v = (await r.json()) as { version?: string };
      return `${config.forgejoUrl} → ${v.version ?? "unknown version"}`;
    }),
  );

  results.push(
    await check("admin token has admin scope", async () => {
      // /admin/users requires admin permission; a 200 means the token works
      // for provisioning. 401/403 → wrong token. 404 → ancient Forgejo.
      const r = await fetch(`${config.forgejoUrl}/api/v1/admin/users?limit=1`, {
        headers: { authorization: `token ${config.forgejoToken}` },
      });
      if (r.status === 401 || r.status === 403) throw new Error("token rejected (not admin?)");
      if (!r.ok) throw new Error(`unexpected ${r.status}`);
      return "ok";
    }),
  );

  results.push(
    await check("admin user exists in forgejo", async () => {
      const u = await forgejo.getUserByName(config.forgejoOwner);
      if (!u) throw new Error(`COSHEAF_FORGEJO_OWNER=${config.forgejoOwner} not found`);
      return u.login;
    }),
  );

  results.push(
    await check("data dir writable", async () => {
      const probe = path.join(config.dataDir, ".doctor-probe");
      const fs = await import("node:fs/promises");
      await fs.writeFile(probe, "x");
      await fs.unlink(probe);
      return config.dataDir;
    }),
  );

  results.push(
    await check("schema applied (doc_map table exists)", async () => {
      db.prepare("SELECT 1 FROM doc_map LIMIT 1").get();
      return "ok";
    }),
  );

  results.push(
    await checkWarn("webhook_log dedupe table healthy", async () => {
      const total = (db.prepare("SELECT COUNT(*) AS n FROM webhook_log").get() as { n: number }).n;
      if (total === 0) return { status: "ok", detail: "empty (no deliveries yet)" };
      const bad = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM webhook_log WHERE delivery_id IS NULL OR delivery_id = '' OR delivered_at IS NULL OR delivered_at <= 0",
          )
          .get() as { n: number }
      ).n;
      if (bad > 0) throw new Error(`${bad}/${total} rows malformed`);
      return { status: "ok", detail: `${total} rows, all well-formed` };
    }),
  );

  // Per-workspace checks. Workspaces are enumerated from Forgejo (repos
  // under config.forgejoOwner with a `cosheaf-format-*` topic), not from
  // SQLite — there's no workspaces table anymore.
  const repos = await forgejo.listUserRepos(config.forgejoOwner, { limit: 50 });
  const workspaceRepos = repos.filter((r) => (r.topics ?? []).some(isFormatTopic));
  const workspaces = workspaceRepos.map((r) => ({
    slug: r.name,
    topics: r.topics ?? [],
    defaultMdFormat: documentFormatFromTopics(r.topics ?? []),
  }));
  const knownSlugs = new Set(workspaces.map((w) => w.slug));

  for (const ws of workspaces) {
    results.push(
      await check(`workspace ${ws.slug}: forgejo repo exists`, async () => {
        const r = await forgejo.getRepo(config.forgejoOwner, ws.slug);
        if (!r) throw new Error(`repo ${config.forgejoOwner}/${ws.slug} missing`);
        return r.full_name;
      }),
    );

    results.push(
      await check(`workspace ${ws.slug}: format topic well-formed`, async () => {
        const formatTopics = ws.topics.filter(isFormatTopic);
        if (formatTopics.length === 0) throw new Error("no cosheaf-format-* topic");
        if (formatTopics.length > 1) {
          throw new Error(`multiple format topics: ${formatTopics.join(", ")}`);
        }
        const suffix = formatTopics[0].slice("cosheaf-format-".length);
        if (!isDocumentFormatId(suffix)) {
          throw new Error(`unknown format suffix in topic ${formatTopics[0]}`);
        }
        if (suffix !== ws.defaultMdFormat) {
          throw new Error(`topic ${formatTopics[0]} does not match resolved format ${ws.defaultMdFormat}`);
        }
        return `${formatTopics[0]} → ${ws.defaultMdFormat}`;
      }),
    );

    if (ws.defaultMdFormat === COFLAT_FORMAT_ID) {
      results.push(
        await check(`workspace ${ws.slug}: webhook installed`, async () => {
          const hooks = await forgejo.listRepoHooks(config.forgejoOwner, ws.slug);
          const ours = hooks.find((h) => Array.isArray(h.events) && h.events.includes("push"));
          if (!ours) throw new Error("no push webhook on repo");
          return `hook id=${ours.id}`;
        }),
      );
      const lastDelivery = db
        .prepare(
          "SELECT delivered_at, event_type FROM webhook_log ORDER BY delivered_at DESC LIMIT 1",
        )
        .get() as { delivered_at: number; event_type: string } | undefined;
      results.push({
        name: `workspace ${ws.slug}: recent webhook activity`,
        status: lastDelivery !== undefined ? "ok" : "fail",
        detail: lastDelivery
          ? `last ${lastDelivery.event_type} at ${new Date(lastDelivery.delivered_at).toISOString()}`
          : "no webhook deliveries logged yet",
      });

      results.push(
        await checkWarn(`workspace ${ws.slug}: sidecar in sync with Forgejo tree`, async () => {
          const tree = await forgejo.getTree(config.forgejoOwner, ws.slug, "main", true);
          const forgejoCount = tree.filter((e) => e.type === "blob" && e.path.endsWith(".md")).length;
          const sidecarCount = (
            db
              .prepare("SELECT COUNT(*) AS n FROM doc_map WHERE workspace_slug = ?")
              .get(ws.slug) as { n: number }
          ).n;
          if (forgejoCount === sidecarCount) {
            return { status: "ok", detail: `${sidecarCount} pages` };
          }
          const delta = forgejoCount - sidecarCount;
          return {
            status: "warn",
            detail: `forgejo=${forgejoCount} sidecar=${sidecarCount} (Δ=${delta >= 0 ? "+" : ""}${delta}); run \`pnpm cli workspace reindex ${ws.slug}\``,
          };
        }),
      );
    } else {
      results.push({
        name: `workspace ${ws.slug}: no webhook expected (passthrough)`,
        status: "ok",
        detail: `format=${ws.defaultMdFormat}`,
      });
    }
  }

  // Sidecar-orphan check: any workspace_slug in doc_map that no longer
  // corresponds to a Forgejo repo carrying a cosheaf-format-* topic.
  const sidecarSlugs = (
    db.prepare("SELECT DISTINCT workspace_slug FROM doc_map").all() as Array<{ workspace_slug: string }>
  ).map((r) => r.workspace_slug);
  for (const slug of sidecarSlugs) {
    if (knownSlugs.has(slug)) continue;
    results.push(
      await check(`sidecar orphan: workspace ${slug}`, async () => {
        const repo = await forgejo.getRepo(config.forgejoOwner, slug);
        if (!repo) {
          throw new Error(`doc_map references ${slug} but Forgejo repo is gone; run \`pnpm cli workspace rm ${slug}\``);
        }
        const hasFormat = (repo.topics ?? []).some(isFormatTopic);
        if (!hasFormat) {
          throw new Error(`repo ${config.forgejoOwner}/${slug} exists but has no cosheaf-format-* topic; add a topic or run \`pnpm cli workspace rm ${slug}\``);
        }
        // Defensive: should be unreachable because knownSlugs is built from the same predicate.
        return "ok";
      }),
    );
  }

  let failed = 0;
  let warned = 0;
  for (const r of results) {
    const mark = r.status === "ok" ? "OK" : r.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${r.name} — ${r.detail}`);
    if (r.status === "fail") failed++;
    else if (r.status === "warn") warned++;
  }
  if (failed > 0) {
    console.error(`\n${failed} check${failed === 1 ? "" : "s"} failed${warned > 0 ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}`);
    process.exit(1);
  }
  const tail = warned > 0 ? ` (${warned} warning${warned === 1 ? "" : "s"})` : "";
  console.log(`\nall ${results.length} checks passed${tail}`);
}

// ---------------------------- inspect workspace ----------------------------

async function inspectWorkspace(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ config, db, forgejo, workspace: ws }) => {
  const repo = await forgejo.getRepo(config.forgejoOwner, ws.slug).catch(() => null);
  const display = repo?.description?.trim() || ws.slug;
  console.log(
    `workspace ${ws.slug} (${display}) — forgejo repo ${config.forgejoOwner}/${ws.slug}, format ${ws.defaultMdFormat}\n`,
  );

  const sidecarPaths = new Set(
    (
      db
        .prepare("SELECT forgejo_id AS path FROM doc_map WHERE workspace_slug = ?")
        .all(ws.slug) as Array<{ path: string }>
    ).map((r) => r.path),
  );
  let forgejoPaths: Set<string>;
  try {
    const tree = await forgejo.getTree(config.forgejoOwner, ws.slug, "main", true);
    forgejoPaths = new Set(
      tree.filter((e) => e.type === "blob" && e.path.endsWith(".md")).map((e) => e.path),
    );
  } catch (err) {
    console.error(`getTree failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const onlySidecar = [...sidecarPaths].filter((p) => !forgejoPaths.has(p)).sort();
  const onlyForgejo = [...forgejoPaths].filter((p) => !sidecarPaths.has(p)).sort();
  const both = sidecarPaths.size + forgejoPaths.size - onlySidecar.length - onlyForgejo.length;

  console.log(`pages: ${both} in sync, ${onlySidecar.length} sidecar-only, ${onlyForgejo.length} forgejo-only`);
  for (const p of onlySidecar) console.log(`  - sidecar-only: ${p}   (run \`workspace reindex\`)`);
  for (const p of onlyForgejo) console.log(`  - forgejo-only: ${p}   (webhook missed it; reindex)`);

  console.log();
  const recentHooks = db
    .prepare(
      "SELECT delivered_at, event_type, delivery_id FROM webhook_log ORDER BY delivered_at DESC LIMIT 10",
    )
    .all() as Array<{ delivered_at: number; event_type: string; delivery_id: string }>;
  if (recentHooks.length === 0) {
    console.log("webhook_log: empty (no deliveries yet)");
  } else {
    console.log(`webhook_log (last ${recentHooks.length}):`);
    for (const h of recentHooks) {
      console.log(`  ${new Date(h.delivered_at).toISOString()}  ${h.event_type.padEnd(20)} ${h.delivery_id}`);
    }
  }

  console.log();
  const pulls = await forgejo.listPulls(config.forgejoOwner, ws.slug, "open");
  console.log(`open PRs (${pulls.length}):`);
  for (const p of pulls) {
    console.log(`  #${p.number} ${p.title.slice(0, 60)}  by ${p.user?.login ?? "(deleted)"}  head=${p.head.ref}`);
  }

  console.log();
  const branches = await forgejo.listBranches(config.forgejoOwner, ws.slug);
  const userBranches = branches.filter((b) => b.name.startsWith("user/"));
  console.log(`user/* branches (${userBranches.length}):`);
  for (const b of userBranches.slice(0, 20)) {
    console.log(`  ${b.name}  @${b.commit?.id?.slice(0, 8) ?? "?"}`);
  }
  if (userBranches.length > 20) console.log(`  … ${userBranches.length - 20} more`);
  });
}

// ------------------------------- drift-check -------------------------------

// Diagnostic-only: compares `doc_map` against Forgejo's `main` tree for the
// given workspace. No auto-repair. Exit 1 if drift detected so the command
// is scriptable (e.g. periodic check, CI sanity).
async function workspaceDriftCheck(slug: string): Promise<void> {
  await withWorkspace(slug, async ({ config, db, forgejo, workspace: ws }) => {
  const sidecarPaths = new Set(
    (
      db
        .prepare("SELECT forgejo_id AS path FROM doc_map WHERE workspace_slug = ?")
        .all(ws.slug) as Array<{ path: string }>
    ).map((r) => r.path),
  );
  let forgejoPaths: Set<string>;
  try {
    const tree = await forgejo.getTree(config.forgejoOwner, ws.slug, "main", true);
    forgejoPaths = new Set(
      tree.filter((e) => e.type === "blob" && e.path.endsWith(".md")).map((e) => e.path),
    );
  } catch (err) {
    console.error(`drift-check: getTree failed: ${(err as Error).message}`);
    process.exit(2);
  }

  const onlySidecar = [...sidecarPaths].filter((p) => !forgejoPaths.has(p)).sort();
  const onlyForgejo = [...forgejoPaths].filter((p) => !sidecarPaths.has(p)).sort();
  const inSync = sidecarPaths.size + forgejoPaths.size - onlySidecar.length - onlyForgejo.length;

  if (onlySidecar.length === 0 && onlyForgejo.length === 0) {
    console.log(`drift-check ${slug}: clean (${inSync} pages in sync)`);
    return;
  }

  console.log(`drift-check ${slug}: DRIFT (${inSync} in sync, ${onlySidecar.length} sidecar-only, ${onlyForgejo.length} forgejo-only)`);
  for (const p of onlySidecar) console.log(`  sidecar-only: ${p}`);
  for (const p of onlyForgejo) console.log(`  forgejo-only: ${p}`);
  console.log(`\nrun \`pnpm cli workspace reindex ${slug}\` to rebuild from Forgejo`);
  process.exit(1);
  });
}

// ---------------------------------- repl ----------------------------------

function startRepl(): void {
  const { config, db, forgejo } = ctx();
  console.log(
    "cosheaf repl — bindings: db (better-sqlite3), forgejo (admin Forgejo client), config\n" +
      "  e.g.  db.prepare('SELECT * FROM doc_map').all()\n" +
      "        await forgejo.getRepo(config.forgejoOwner, 'notes')\n",
  );
  const r = repl.start({ prompt: "cosheaf> ", useGlobal: true, breakEvalOnSigint: true });
  r.context.db = db;
  r.context.forgejo = forgejo;
  r.context.config = config;
}

// ------------------------------- reset-dev -------------------------------

async function resetDev(opts: { keepForgejo: boolean; yes: boolean }): Promise<void> {
  const { config, db, forgejo } = ctx();
  // Workspaces are enumerated from Forgejo, not SQLite.
  const allRepos = await forgejo.listUserRepos(config.forgejoOwner, { limit: 50 });
  const repos = allRepos
    .filter((r) => (r.topics ?? []).some(isFormatTopic))
    .map((r) => `${config.forgejoOwner}/${r.name}`);

  console.error("This will:");
  console.error(`  - delete ${path.join(config.dataDir, "db.sqlite")} (+ -shm/-wal)`);
  if (!opts.keepForgejo) {
    for (const r of repos) console.error(`  - delete forgejo repo ${r}`);
  } else {
    console.error("  - keep all forgejo repos (--keep-forgejo)");
  }
  console.error(`  - re-seed via pnpm setup:dev defaults`);
  if (!opts.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question("continue? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.error("aborted");
      process.exit(1);
    }
  }

  if (!opts.keepForgejo) {
    for (const r of allRepos.filter((rr) => (rr.topics ?? []).some(isFormatTopic))) {
      try {
        await forgejo.deleteRepo(config.forgejoOwner, r.name);
        console.error(`deleted forgejo repo ${r.name}`);
      } catch (err) {
        if (!(err instanceof ForgejoError && err.status === 404)) {
          console.error(`warning: deleteRepo ${r.name} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // Close DB before unlinking — better-sqlite3 holds the handle.
  db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = path.join(config.dataDir, `db.sqlite${suffix}`);
    if (existsSync(file)) unlinkSync(file);
  }
  console.error("wiped local DB; run `pnpm setup:dev` to reseed.");
}

function parseRole(value: string): Role {
  if (!(ROLES as readonly string[]).includes(value))
    throw new InvalidArgumentError(`role must be ${ROLES.join("|")}`);
  return value as Role;
}

function buildProgram(): Command {
  const program = new Command("cosheaf").description("cosheaf admin CLI").exitOverride();

  program
    .command("seed")
    .description("create-or-update a forgejo user and workspace for local development")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action((_opts, cmd) => seed(cmd.args));

  const user = program.command("user").description("user management");
  user.command("add <username>").description("create a forgejo user; prompts for password").action(userAdd);
  user
    .command("create <username> <password>")
    .description("non-interactive create (dev/CI use)")
    .action(ensureForgejoUser);

  const workspace = program.command("workspace").description("workspace management");
  workspace
    .command("member <slug> <username> <role>")
    .description("set a collaborator's Forgejo role (admin|write|read)")
    .action((slug, username, roleArg) => workspaceMember(slug, username, parseRole(roleArg)));
  workspace
    .command("reindex <slug>")
    .description("rebuild the SQLite sidecar from Forgejo main")
    .action(workspaceReindex);
  workspace
    .command("rm <slug>")
    .description("delete the Forgejo repo and the SQLite sidecar")
    .action(workspaceRm);
  workspace
    .command("inspect <slug>")
    .description("show sidecar vs forgejo drift, recent webhook deliveries, open PRs, user branches")
    .action(inspectWorkspace);
  workspace
    .command("drift-check <slug>")
    .description("diagnostic: report differences between doc_map and Forgejo's main tree (exit 1 on drift)")
    .action(workspaceDriftCheck);

  program
    .command("doctor")
    .description("check that forgejo, admin token, schema, and per-workspace state are sane")
    .action(doctor);

  program
    .command("repl")
    .description("Node REPL with db, forgejo (admin), and config preloaded")
    .action(startRepl);

  program
    .command("reset-dev")
    .description("wipe the local DB and (optionally) the workspace forgejo repos, then reseed")
    .option("--keep-forgejo", "do not delete forgejo repos", false)
    .option("-y, --yes", "skip the confirmation prompt", false)
    .action(resetDev);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof Error && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "commander.help" || code === "commander.helpDisplayed") return;
      if (code === "commander.version") return;
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  void main();
}
