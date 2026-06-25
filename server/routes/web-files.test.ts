import { readFile, writeFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COFLAT_FORMAT_ID } from "../../shared/document-format.js";
import { indexPage } from "../indexer.js";
import { _resetMiddlewareCachesForTests } from "../middleware.js";
import { _resetPdfExportLimiterForTest, _setPdfExportCommandRunnerForTest, _setPdfExportLimiterConfigForTest } from "../pdf-export.js";
import { authHeaders, formHeaders, seedAuthUser } from "../test-helpers.js";
import { _clearTreeCacheForTests } from "../tree-cache.js";
import type { AppEnv } from "../types.js";
import { fakeForgejo, freshTestDb, seedTestWorkspace, testApp, testConfig } from "./test-fixtures.js";
import { registerBranchRoutes } from "./web-branches.js";
import { registerFileRoutes } from "./web-files.js";

const config = testConfig("web-files");

function appFor(db: Database.Database): Hono<AppEnv> {
  return testApp(db, config, (app) => {
    registerFileRoutes(app);
    registerBranchRoutes(app);
  });
}

async function writeFakePdf(args: readonly string[]): Promise<void> {
  const outputIndex = args.indexOf("-o");
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const outputFile = outputArg?.slice("--output=".length) ?? (outputIndex >= 0 ? args[outputIndex + 1] : null);
  if (!outputFile) throw new Error("missing pandoc output path");
  await writeFile(outputFile, Buffer.from("%PDF-1.4\n"));
}

describe("web file editor route", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    _resetMiddlewareCachesForTests();
    _clearTreeCacheForTests();
  });

  afterEach(() => {
    _setPdfExportCommandRunnerForTest(null);
    _resetPdfExportLimiterForTest();
    vi.unstubAllGlobals();
  });

  it("renders a repo-home overview above the README", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "README.md",
      bodyText: "---\nid: readme\n---\n# Read Me\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let listedPulls = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/user", () => Response.json({ id: 1, login: "alice" }));
        forge.get("/api/v1/repos/owner/w", () =>
          Response.json({
            name: "w",
            full_name: "owner/w",
            description: "A focused knowledge repo",
            ssh_url: "ssh://git@forge.cosheaf.test:2222/owner/w.git",
            updated_at: "2026-06-16T12:34:00Z",
            open_issues_count: 3,
          }),
        );
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "README.md", name: "README.md", type: "blob" },
              { path: "notes/a.md", name: "a.md", type: "blob" },
              { path: "assets/logo.png", name: "logo.png", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "draft" }]));
        forge.get("/api/v1/repos/owner/w/pulls", () => {
          listedPulls = true;
          return Response.json([
            { number: 1, title: "One", state: "open", head: { ref: "draft" }, base: { ref: "main" }, user: { login: "alice" } },
            { number: 2, title: "Two", state: "open", head: { ref: "other" }, base: { ref: "main" }, user: { login: "bob" } },
          ]);
        });
        forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Read Me\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="repo-home-header"');
    expect(body).toContain("A focused knowledge repo");
    expect(body).toContain('<span class="repo-stat-num">2</span><span class="repo-stat-label">pages</span>');
    expect(body).toContain('<span class="repo-stat-num">2</span><span class="repo-stat-label">branches</span>');
    expect(body).toContain('<span class="repo-stat-num">3</span><span class="repo-stat-label">open issues</span>');
    expect(body).not.toContain("open PRs");
    expect(body).toContain('data-testid="repo-clone"');
    expect(body).toContain('aria-label="SSH clone URL"');
    expect(body).toContain('data-testid="repo-readme"');
    expect(body).toContain('<div class="repo-readme-label">README.md</div>');
    expect(body).toContain('value="ssh://git@forge.cosheaf.test:2222/owner/w.git"');
    expect(body).toContain('href="/owner/w/src/branch/main/README.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit"');
    expect(body).toContain('data-file-open-link data-edit-href="/owner/w/src/branch/main/README.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit" data-read-href="/owner/w/src/branch/main/README.md"');
    expect(body).toContain('href="/owner/w/src/branch/main/notes/a.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit"');
    expect(body).toContain('data-file-open-link data-edit-href="/owner/w/src/branch/main/notes/a.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit" data-read-href="/owner/w/src/branch/main/notes/a.md"');
    expect(body).toContain('<form class="newfile" action="/owner/w/src/branch/main" method="get">');
    expect(body).toContain('<input type="hidden" name="mode" value="edit">');
    expect(body).toContain('<input type="hidden" name="edit_branch" value="user/alice/web-edit">');
    expect(body).toContain('<input class="newfile-path" name="path" value="new.md"');
    expect(body).not.toContain('<a class="button" href="/owner/w/branches">Branches</a>');
    expect(listedPulls).toBe(false);
  });

  it("keeps the rendered file reader available without a Branches toolbar button", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/web-edit" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }),
        );
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
        forge.post("/api/v1/repos/owner/w/markdown", () => Response.json({ html: "<h1>Notes</h1>" }));
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/notes.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/owner/w/src/branch/main/notes.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit"');
    expect(body).toContain('class="doc-rail"');
    expect(body).toContain("data-document-rail");
    expect(body).toContain('data-doc-mode="read"');
    expect(body).toContain('data-read-href="/owner/w/src/branch/main/notes.md"');
    expect(body).toContain('data-edit-href="/owner/w/src/branch/main/notes.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit"');
    expect(body).toContain('class="doc-reader-chrome"');
    expect(body).toContain("<summary>More</summary>");
    expect(body).toContain('href="/owner/w/export/pdf/options/branch/main/notes.md">PDF</a>');
    expect(body).toContain('href="/owner/w/raw/branch/main/notes.md">Raw</a>');
    expect(body).not.toContain("data-pdf-href");
    expect(body).not.toContain("data-raw-href");
    expect(body).not.toContain('data-reader-toc');
    expect(body).not.toContain('<div class="doc-view-controls" aria-label="View">');
    expect(body).not.toContain('<a class="button" href="/owner/w/branches">Branches</a>');
    expect(body).not.toContain('<a class="button" href="/owner/w/raw/branch/main/notes.md">Raw</a>');
    expect(body).not.toContain('<a class="button" href="/owner/w/src/branch/main/notes.md?view=source">Source</a>');
    expect(body).not.toContain('<summary class="button">More</summary>');

    const sourceRes = await appFor(db).request("/owner/w/src/branch/main/notes.md?view=source", { headers: authHeaders(token) });
    expect(sourceRes.status).toBe(200);
    const sourceBody = await sourceRes.text();
    expect(sourceBody).toContain('<div class="doc-with-toc">');
    expect(sourceBody).toContain('<div class="doc-main">');
    expect(sourceBody).toContain('<article class="file-preview file-preview-source-lines" data-testid="file-preview-source">');
    expect(sourceBody).toContain('data-read-href="/owner/w/src/branch/main/notes.md"');
    expect(sourceBody).toContain('/src/cosheaf/web-reader.ts');
    expect(sourceBody).toContain("data-document-rail-source");
    expect(sourceBody).not.toContain('href="/owner/w/src/branch/main/notes.md?view=source"');
    expect(sourceBody).not.toContain("<h1>notes.md</h1>");
    expect(sourceBody).not.toContain('<a class="button" href="/owner/w/src/branch/main/notes.md?view=source">Source</a>');
  });

  it("reuses the cached Forgejo tree across server-rendered file pages", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let treeCalls = 0;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => {
          treeCalls += 1;
          return Response.json({
            tree: [
              { path: "a.md", type: "blob" },
              { path: "b.md", type: "blob" },
            ],
            truncated: false,
          });
        });
        forge.get("/api/v1/repos/owner/w/contents/:path", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/:path", (c) => new Response(`# ${c.req.param("path")}\n`));
      }),
    );

    const first = await appFor(db).request("/owner/w/src/branch/main/a.md", { headers: authHeaders(token) });
    const second = await appFor(db).request("/owner/w/src/branch/main/b.md", { headers: authHeaders(token) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(treeCalls).toBe(1);
  });

  it("previews a small extensionless UTF-8 file as plain text", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({ tree: [{ path: ".gitignore", type: "blob", size: 18 }], truncated: false }),
        );
        forge.get("/api/v1/repos/owner/w/contents/.gitignore", () => Response.json({ sha: "ignore-sha", size: 18 }));
        forge.get("/api/v1/repos/owner/w/raw/.gitignore", () => new Response("node_modules\n.env\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/.gitignore", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="file-preview-text"');
    expect(body).toContain('data-testid="file-preview-text-raw" data="/owner/w/raw/branch/main/.gitignore" type="text/plain"');
    expect(body).not.toContain("No inline preview is available");
    expect(body).not.toContain('href="/owner/w/_edit?branch=user%2Falice%2Fweb-edit&amp;mode=edit&amp;path=.gitignore"');
  });

  it("does not fetch large unknown files only to sniff a text preview", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let rawFetched = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({ tree: [{ path: "big-data", type: "blob", size: 300_000 }], truncated: false }),
        );
        forge.get("/api/v1/repos/owner/w/contents/big-data", () => Response.json({ sha: "big-sha", size: 300_000 }));
        forge.get("/api/v1/repos/owner/w/raw/big-data", () => {
          rawFetched = true;
          return new Response("large text\n");
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/big-data", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="file-preview-raw"');
    expect(body).toContain("No inline preview is available");
    expect(rawFetched).toBe(false);
  });

  it("exports a Coflat markdown file as PDF through the shared Latex contract", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    _setPdfExportCommandRunnerForTest(async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command !== "pandoc") return;
      const outputArg = args.find((arg) => arg.startsWith("--output="));
      if (!outputArg) return;
      const inputPath = args[args.length - 1];
      const source = await readFile(inputPath, "utf8");
      expect(source).toContain("\\begin{equation}\\label{eq:main}");
      await writeFile(outputArg.slice("--output=".length), Buffer.from("%PDF-test\n"));
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return Response.json({ sha: "current-sha" });
        });
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "docs/main.md", type: "blob" },
              { path: "figures/example.png", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/raw/docs/main.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("# Printable\n\n$$\nx\n$$ {#eq:main}\n");
        });
        forge.get("/api/v1/repos/owner/w/raw/figures/example.png", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("image bytes");
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/docs/main.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="main.pdf"');
    expect(await res.text()).toBe("%PDF-test\n");
    expect(commands.map((entry) => `${entry.command} ${entry.args.join(" ")}`)).toEqual([
      "pandoc --version",
      "xelatex --version",
      expect.stringContaining("pandoc --from=markdown+fenced_divs+raw_tex"),
    ]);
    const pandoc = commands.at(-1);
    expect(pandoc?.args).toContain("--pdf-engine=xelatex");
    expect(pandoc?.args).toContain("--pdf-engine-opt=-no-shell-escape");
    expect(pandoc?.args).toContain("--pdf-engine-opt=-halt-on-error");
    expect(pandoc?.args.some((arg) => arg.startsWith("--lua-filter=") && arg.endsWith("/latex/filter.lua"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--csl=") && arg.endsWith("/latex/csl/ieee.csl"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--resource-path="))).toBe(true);
  });

  it("renders PDF export options from cosheaf.yaml defaults", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("bibliography: refs/main.bib\ncsl: chicago-author-date\ntemplate: lipics\n");
        });
        forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/options/branch/main/docs/main.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-testid="pdf-export-options"');
    expect(body).toContain('action="/owner/w/export/pdf/branch/main/docs/main.md"');
    expect(body).toContain('name="bibliography" placeholder="refs/main.bib"');
    expect(body).toContain('name="csl" list="pdf-csl-options" placeholder="chicago-author-date"');
    expect(body).toContain('name="template" list="pdf-template-options" placeholder="lipics"');
    expect(body).not.toContain('name="bibliography" value=');
    expect(body).not.toContain('name="csl" value=');
    expect(body).not.toContain('name="template" value=');
  });

  it("uses cosheaf.yaml PDF defaults when document frontmatter is silent", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    _setPdfExportCommandRunnerForTest(async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command !== "pandoc") return;
      const outputArg = args.find((arg) => arg.startsWith("--output="));
      if (outputArg) await writeFile(outputArg.slice("--output=".length), Buffer.from("%PDF-test\n"));
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "docs/main.md", type: "blob" },
              { path: "refs/main.bib", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/raw/docs/main.md", () => new Response("# Printable\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/main.bib", () => new Response("@book{x, title={X}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", () => new Response("bibliography: refs/main.bib\ncsl: ieee\ntemplate: lipics\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/docs/main.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const pandoc = commands.at(-1);
    expect(pandoc?.args).toContain("--metadata=bibliography=refs/main.bib");
    expect(pandoc?.args.some((arg) => arg.startsWith("--csl=") && arg.endsWith("/latex/csl/ieee.csl"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/latex/template/lipics.tex"))).toBe(true);
  });

  it("prefers cosheaf.yaml nested PDF defaults over top-level reader defaults for export", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    _setPdfExportCommandRunnerForTest(async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command !== "pandoc") return;
      const outputArg = args.find((arg) => arg.startsWith("--output="));
      if (outputArg) await writeFile(outputArg.slice("--output=".length), Buffer.from("%PDF-test\n"));
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "docs/main.md", type: "blob" },
              { path: "refs/reader.bib", type: "blob" },
              { path: "refs/export.bib", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/raw/docs/main.md", () => new Response("# Printable\n"));
        forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", () =>
          new Response([
            "bibliography: refs/reader.bib",
            "csl: styles/reader.csl",
            "latex:",
            "  bibliography: refs/export.bib",
            "  csl: ieee",
            "pdf:",
            "  template: lipics",
            "",
          ].join("\n")),
        );
        forge.get("/api/v1/repos/owner/w/raw/refs/reader.bib", () => new Response("@book{reader, title={Reader}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/export.bib", () => new Response("@book{export, title={Export}}\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/docs/main.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const pandoc = commands.at(-1);
    expect(pandoc?.args).toContain("--metadata=bibliography=refs/export.bib");
    expect(pandoc?.args).not.toContain("--metadata=bibliography=refs/reader.bib");
    expect(pandoc?.args.some((arg) => arg.startsWith("--csl=") && arg.endsWith("/latex/csl/ieee.csl"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/latex/template/lipics.tex"))).toBe(true);
  });

  it("lets document PDF frontmatter override cosheaf.yaml defaults", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    _setPdfExportCommandRunnerForTest(async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command !== "pandoc") return;
      const outputArg = args.find((arg) => arg.startsWith("--output="));
      if (outputArg) await writeFile(outputArg.slice("--output=".length), Buffer.from("%PDF-test\n"));
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "docs/main.md", type: "blob" },
              { path: "refs/doc.bib", type: "blob" },
              { path: "refs/repo.bib", type: "blob" },
              { path: "styles/doc.csl", type: "blob" },
              { path: "templates/doc.tex", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/raw/docs/main.md", () =>
          new Response([
            "---",
            "bibliography: refs/doc.bib",
            "latex:",
            "  csl: styles/doc.csl",
            "  template: templates/doc.tex",
            "---",
            "# Printable",
            "",
          ].join("\n")),
        );
        forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", () => new Response("bibliography: refs/repo.bib\ncsl: ieee\ntemplate: lipics\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/doc.bib", () => new Response("@book{x, title={X}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/repo.bib", () => new Response("@book{y, title={Y}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/styles/doc.csl", () => new Response("<style></style>\n"));
        forge.get("/api/v1/repos/owner/w/raw/templates/doc.tex", () => new Response("$body$\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/docs/main.md", { headers: authHeaders(token) });

    expect(res.status).toBe(200);
    const pandoc = commands.at(-1);
    expect(pandoc?.args).toContain("--metadata=bibliography=refs/doc.bib");
    expect(pandoc?.args).not.toContain("--metadata=bibliography=refs/repo.bib");
    expect(pandoc?.args.some((arg) => arg.startsWith("--csl=") && arg.endsWith("/styles/doc.csl"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/templates/doc.tex"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/latex/template/lipics.tex"))).toBe(false);
  });

  it("keeps document PDF frontmatter when the options form submits untouched fields", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const commands: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    _setPdfExportCommandRunnerForTest(async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command !== "pandoc") return;
      const outputArg = args.find((arg) => arg.startsWith("--output="));
      if (outputArg) await writeFile(outputArg.slice("--output=".length), Buffer.from("%PDF-test\n"));
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/docs/main.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () =>
          Response.json({
            tree: [
              { path: "docs/main.md", type: "blob" },
              { path: "refs/doc.bib", type: "blob" },
              { path: "refs/repo.bib", type: "blob" },
              { path: "templates/doc.tex", type: "blob" },
            ],
            truncated: false,
          }),
        );
        forge.get("/api/v1/repos/owner/w/raw/docs/main.md", () =>
          new Response([
            "---",
            "bibliography: refs/doc.bib",
            "latex:",
            "  template: templates/doc.tex",
            "---",
            "# Printable",
            "",
          ].join("\n")),
        );
        forge.get("/api/v1/repos/owner/w/raw/cosheaf.yaml", () => new Response("bibliography: refs/repo.bib\ntemplate: lipics\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/doc.bib", () => new Response("@book{x, title={X}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/refs/repo.bib", () => new Response("@book{y, title={Y}}\n"));
        forge.get("/api/v1/repos/owner/w/raw/templates/doc.tex", () => new Response("$body$\n"));
      }),
    );

    const res = await appFor(db).request(
      "/owner/w/export/pdf/branch/main/docs/main.md?bibliography=&csl=&template=",
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const pandoc = commands.at(-1);
    expect(pandoc?.args).toContain("--metadata=bibliography=refs/doc.bib");
    expect(pandoc?.args).not.toContain("--metadata=bibliography=refs/repo.bib");
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/templates/doc.tex"))).toBe(true);
    expect(pandoc?.args.some((arg) => arg.startsWith("--template=") && arg.endsWith("/latex/template/lipics.tex"))).toBe(false);
  });

  it("rejects PDF export for non-Coflat markdown workspaces", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Coflat Markdown");
  });

  it("rejects absolute custom PDF template paths", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    _setPdfExportCommandRunnerForTest(async () => {});
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob", size: 8 }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md?template=/etc/passwd", { headers: authHeaders(token) });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid PDF template path.");
  });

  it("rejects absolute custom PDF citation style paths", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    _setPdfExportCommandRunnerForTest(async () => {});
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob", size: 8 }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md?csl=/etc/passwd", { headers: authHeaders(token) });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid PDF citation style path.");
  });

  it("reports missing PDF export dependencies clearly", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    _setPdfExportCommandRunnerForTest(async (command) => {
      if (command === "xelatex") throw new Error("not found");
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
      }),
    );

    const res = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("PDF export requires xelatex.");
  });

  it("rejects PDF export when the render queue is full", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const secondToken = seedAuthUser(db, config, { username: "bob", role: "write" });
    _setPdfExportLimiterConfigForTest({ concurrency: 1, queueLimit: 0, cooldownMs: 0 });
    let releasePandoc: (() => void) | undefined;
    let branchReads = 0;
    let rawReads = 0;
    const pandocStarted = new Promise<void>((resolve) => {
      _setPdfExportCommandRunnerForTest(async (command, args) => {
        if (command !== "pandoc" || !args.some((arg) => arg.startsWith("--output="))) return;
        resolve();
        await new Promise<void>((release) => {
          releasePandoc = release;
        });
        await writeFakePdf(args);
      });
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => {
          branchReads += 1;
          return Response.json([{ name: "main" }]);
        });
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => {
          rawReads += 1;
          return new Response("# Notes\n");
        });
      }),
    );

    const first = appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });
    await pandocStarted;
    const second = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(secondToken) });
    if (!releasePandoc) throw new Error("pandoc did not start");
    releasePandoc();
    const firstRes = await first;

    expect(second.status).toBe(503);
    expect(await second.text()).toContain("PDF export queue is full");
    expect(firstRes.status).toBe(200);
    expect(branchReads).toBe(1);
    expect(rawReads).toBe(1);
  });

  it("throttles repeated PDF export requests from the same user and client IP", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    _setPdfExportLimiterConfigForTest({ concurrency: 1, queueLimit: 1, cooldownMs: 60_000 });
    _setPdfExportCommandRunnerForTest(async (command, args) => {
      if (command === "pandoc" && args.some((arg) => arg.startsWith("--output="))) await writeFakePdf(args);
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
      }),
    );

    const first = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });
    const second = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await second.text()).toContain("PDF export is already running or was requested recently.");
  });

  it("rejects duplicate PDF exports before branch resolution while one is active", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    _setPdfExportLimiterConfigForTest({ concurrency: 1, queueLimit: 4, cooldownMs: 0 });
    let releasePandoc: (() => void) | undefined;
    let branchReads = 0;
    const pandocStarted = new Promise<void>((resolve) => {
      _setPdfExportCommandRunnerForTest(async (command, args) => {
        if (command !== "pandoc" || !args.some((arg) => arg.startsWith("--output="))) return;
        resolve();
        await new Promise<void>((release) => {
          releasePandoc = release;
        });
        await writeFakePdf(args);
      });
    });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => {
          branchReads += 1;
          return Response.json([{ name: "main" }]);
        });
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/git/trees/main", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
      }),
    );

    const first = appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });
    await pandocStarted;
    const second = await appFor(db).request("/owner/w/export/pdf/branch/main/notes.md", { headers: authHeaders(token) });
    if (!releasePandoc) throw new Error("pandoc did not start");
    releasePandoc();
    const firstRes = await first;

    expect(second.status).toBe(429);
    expect(await second.text()).toContain("PDF export is already running or was requested recently.");
    expect(firstRes.status).toBe(200);
    expect(branchReads).toBe(1);
  });

  it("uses source freshness when an existing edit branch lacks the file and falls back to main content", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: "user/alice/wip" }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "user/alice/wip") return c.text("not found", 404);
          expect(c.req.query("ref")).toBe("main");
          return c.json({ sha: "main-sha" });
        });
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return c.text("# Main Notes\n");
        });
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("user/alice/wip");
          return c.json({ tree: [], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/notes.md?mode=edit&edit_branch=user%2Falice%2Fwip", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-branch-exists="1"');
    expect(body).toContain('data-read-branch="main"');
    expect(body).toContain('data-base-sha=""');
    expect(body).toContain('data-source-sha="main-sha"');
    expect(body).toContain('name="expected_sha" value=""');
    expect(body).toContain('name="expected_source_sha" value="main-sha"');
    expect(body).toContain("# Main Notes\\n");
  });

  it("renders Coflat edit pages as an editor-backed read/edit workbench", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: decodeURIComponent(c.req.path.split("/branches/")[1] ?? ""), commit: { id: "branch-head" } }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "branch-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md?mode=read", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-edit-shell data-initial-mode="read" data-mode="read"');
    expect(body).not.toContain("data-edit-read-panel");
    expect(body).not.toContain("data-edit-reader-payload");
    expect(body).toContain('id="web-editor-root"');
    expect(body).not.toContain('id="web-editor-root"\n            hidden');
    expect(body).toContain("/src/cosheaf/web-edit-shell.ts");
    expect(body).not.toContain("/src/cosheaf/web-reader.ts");
    expect(body).not.toContain('/src/cosheaf/web-editor.tsx"></script>');
  });

  it("can start the Coflat workbench directly in edit mode", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", () => Response.json({ name: "user/alice/wip", commit: { id: "branch-head" } }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "branch-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md?mode=edit", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-edit-shell data-initial-mode="edit" data-mode="edit"');
    expect(body).not.toContain("data-edit-read-panel");
    expect(body).toContain('<div\n            id="web-editor-root"');
    expect(body).not.toContain('id="web-editor-root"\n            hidden');
    expect(body).toContain("/src/cosheaf/web-edit-shell.ts");
    expect(body).not.toContain('/src/cosheaf/web-editor.tsx"></script>');
  });

  it("loads main content and marks the default edit branch for reset after a closed unmerged PR", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => {
          const branch = decodeURIComponent(c.req.path.split("/branches/")[1] ?? "");
          if (branch === "main") return c.json({ name: "main", commit: { id: "main-head" } });
          expect(branch).toBe("user/alice/web-edit");
          return c.json({ name: branch, commit: { id: "stale-head" } });
        });
        forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
        forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Workspace\n"));
        forge.get("/api/v1/repos/owner/w/pulls", (c) => {
          expect(c.req.query("state")).toBe("all");
          return c.json([
            { number: 7, state: "closed", merged: false, head: { ref: "user/alice/web-edit" }, base: { ref: "main" } },
          ]);
        });
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main-head");
          return c.json({ sha: "main-sha" });
        });
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main-head");
          return c.text("# Main Notes\n");
        });
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("main");
          return c.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/notes.md?mode=edit&edit_branch=user%2Falice%2Fweb-edit", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('data-branch="user/alice/web-edit"');
    expect(body).toContain('data-branch-exists="0"');
    expect(body).toContain('data-read-branch="main"');
    expect(body).toContain('data-base-sha="main-sha"');
    expect(body).toContain('data-reset-edit-branch="1"');
    expect(body).toContain("# Main Notes\\n");
  });

  it("uses the main blob sha as CAS base when a missing edit branch will be created from main", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.text("not found", 404));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "user/alice/new") return c.text("not found", 404);
          expect(c.req.query("ref")).toBe("main");
          return c.json({ sha: "main-sha" });
        });
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return c.text("# Main Notes\n");
        });
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("main");
          return c.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main/notes.md?mode=edit&edit_branch=user%2Falice%2Fnew", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-branch-exists="0"');
    expect(body).toContain('data-read-branch="main"');
    expect(body).toContain('data-base-sha="main-sha"');
    expect(body).toContain('data-source-sha=""');
    expect(body).toContain('name="expected_sha" value="main-sha"');
    expect(body).toContain('<span class="ftree-branch-name">user/alice/new</span>');
    expect(body).toContain('<span class="branch-ref"');
    expect(body).toContain(">user/alice/new</span>");
    expect(body).toContain('href="/owner/w/src/branch/main/notes.md?mode=edit&amp;edit_branch=user%2Falice%2Fweb-edit"');
    expect(body).toContain("# Main Notes\\n");
  });

  it("opens a new file from the branch route without the legacy edit route", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }]));
        forge.get("/api/v1/repos/owner/w/branches/*", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/fresh.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", (c) => {
          expect(c.req.param("ref")).toBe("main");
          return c.json({ tree: [], truncated: false });
        });
      }),
    );

    const res = await appFor(db).request("/owner/w/src/branch/main?mode=edit&path=fresh.md&edit_branch=user%2Falice%2Fnew", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="web-editor-root"');
    expect(body).toContain('data-path="fresh.md"');
    expect(body).toContain('data-branch="user/alice/new"');
    expect(body).toContain('data-branch-exists="0"');
    expect(body).toContain('data-base-sha=""');
    expect(body).toContain('name="expected_sha" value=""');
  });

  it("rejects invalid edit branch names before loading editor data", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
    }));

    const res = await appFor(db).request("/owner/w/src/branch/main?mode=edit&path=notes.md&edit_branch=bad..branch", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid branch name is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w");
  });

  it("rejects invalid edit paths instead of falling back to the default new file", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
    }));

    const res = await appFor(db).request("/owner/w/src/branch/main?mode=edit&path=docs/./escape.md", {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid file path is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w");
  });

  it("rejects a stale plain form save before overwriting the branch file", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "notes.md",
      path: "notes.md",
      expected_sha: "loaded-sha",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("rejects a fallback plain form save when the main source changed", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => {
          if (c.req.query("ref") === "main") return c.json({ sha: "main-newer" });
          return c.text("not found", 404);
        });
        forge.post("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "notes.md",
      path: "notes.md",
      expected_sha: "",
      expected_source_sha: "main-loaded",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("rejects non-string plain form freshness tokens instead of disabling CAS", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", (c) => c.json({ sha: "current-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new FormData();
    form.set("branch", "user/alice/wip");
    form.set("old_path", "notes.md");
    form.set("path", "notes.md");
    form.set("content", "# Edited\n");
    form.set("expected_sha", new Blob(["loaded-sha"]), "sha.txt");
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: { ...authHeaders(token), origin: "http://localhost" },
      body: form,
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid edit freshness token");
    expect(putCalled).toBe(false);
  });

  it("rejects malformed original paths instead of treating the save as a non-rename", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "../old.md",
      path: "notes.md",
      expected_sha: "loaded-sha",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid original path");
    expect(putCalled).toBe(false);
  });

  it("rejects invalid plain form branch names before mutating Forgejo", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.get("/api/v1/repos/owner/w", () => Response.json({ description: "Workspace" }));
      forge.get("/api/v1/repos/owner/w/raw/README.md", () => new Response("# Workspace\n"));
    }));

    const form = new URLSearchParams({
      branch: "bad..branch",
      old_path: "notes.md",
      path: "notes.md",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Valid branch name is required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://forgejo.test/api/v1/repos/owner/w");
  });

  it("rejects a plain form rename from a non-editable source path before deleting it", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let mutationCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.post("/api/v1/repos/owner/w/branches", () => {
          mutationCalled = true;
          return Response.json({ name: "user/alice/wip" });
        });
        forge.put("/api/v1/repos/owner/w/contents/notes.md", () => {
          mutationCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/assets/logo.png", () => {
          mutationCalled = true;
          return new Response(null);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "assets/logo.png",
      path: "notes.md",
      content: "# Edited\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid original path");
    expect(mutationCalled).toBe(false);
  });

  it("returns a bad request when a plain form rename destination already exists", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => Response.json({ sha: "existing-new" }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.put("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("A file already exists at the new path");
    expect(putCalled).toBe(false);
  });

  it("rejects a plain form rename when the source path is already missing", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let putCalled = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => new Response("not found", { status: 404 }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          putCalled = true;
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
    expect(putCalled).toBe(false);
  });

  it("allows a plain form rename from a main fallback when the source sha is fresh", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deletedOld = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
          if (c.req.query("ref") === "main") return Response.json({ sha: "main-loaded" });
          return new Response("not found", { status: 404 });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          const body = (await c.req.json()) as { message: string; sha?: string };
          expect(body).toMatchObject({ message: "rename old.md to new.md" });
          expect(body.sha).toBeUndefined();
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          deletedOld = true;
          return new Response(null, { status: 204 });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "",
      expected_source_sha: "main-loaded",
      content: "---\nid: new\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/src/branch/user/alice/wip/new.md?mode=edit");
    expect(deletedOld).toBe(false);
  });

  it("does not publish a branch-local plain form rename into the main sidecar", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: old\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("---\nid: old\n---\n# Old\n");
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", () =>
          Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } }),
        );
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => new Response(null, { status: 204 }));
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "---\nid: new\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "old", forgejo_id: "old.md" }]);
  });

  it("preserves branch-only markdown content without moving the main sidecar row", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "old.md",
      bodyText: "---\nid: stable\n---\n# Old\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", (c) => {
          if (c.req.query("ref") === "main") return new Response("not found", { status: 404 });
          return Response.json({ sha: "old-sha" });
        });
        forge.post("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          const body = (await c.req.json()) as { content: string };
          expect(Buffer.from(body.content, "base64").toString("utf8")).toContain("id: stable");
          return Response.json({ commit: { sha: "new-commit" }, content: { sha: "new-sha" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => new Response(null, { status: 204 }));
        forge.get("/api/v1/repos/owner/w/raw/old.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("not found", { status: 404 });
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "---\nid: stable\n---\n# New\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    const rows = db
      .prepare("SELECT cosheaf_id, forgejo_id, title FROM doc_map WHERE workspace_slug = ? ORDER BY forgejo_id")
      .all("owner/w");
    expect(rows).toEqual([{ cosheaf_id: "stable", forgejo_id: "old.md", title: "Old" }]);
  });

  it("rolls back a plain form rename destination when source deletion loses a sha race", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const calls: string[] = [];
    let newCreated = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () =>
          newCreated ? Response.json({ sha: "concurrent-newer" }) : new Response("not found", { status: 404 }),
        );
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("create-new");
          newCreated = true;
          return Response.json({ commit: { sha: "created-commit" }, content: { sha: "new-created" } });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          calls.push("delete-old");
          return new Response("sha does not match [given: old, expected: newer]", { status: 422 });
        });
        forge.delete("/api/v1/repos/owner/w/contents/new.md", async (c) => {
          calls.push("rollback-new");
          const body = (await c.req.json()) as { sha: string; message: string };
          expect(body).toMatchObject({ sha: "new-created", message: "rollback incomplete rename to new.md" });
          return c.body(null, 200);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      expected_sha: "old-sha",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(400);
    expect(calls).toEqual(["create-new", "delete-old", "rollback-new"]);
    expect(await res.text()).toContain("This file changed on the branch while you were editing");
  });

  it("does not rollback-delete a plain form rename destination when Forgejo omitted the created blob sha", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const calls: string[] = [];
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches/*", (c) => c.json({ name: c.req.param("*") }));
        forge.get("/api/v1/repos/owner/w/contents/new.md", () => new Response("not found", { status: 404 }));
        forge.get("/api/v1/repos/owner/w/contents/old.md", () => Response.json({ sha: "old-sha" }));
        forge.post("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("create-new");
          return Response.json({ commit: { sha: "created-commit" }, content: null });
        });
        forge.delete("/api/v1/repos/owner/w/contents/old.md", () => {
          calls.push("delete-old");
          return new Response("sha does not match [given: old, expected: newer]", { status: 422 });
        });
        forge.delete("/api/v1/repos/owner/w/contents/new.md", () => {
          calls.push("rollback-new");
          return new Response(null);
        });
      }),
    );

    const form = new URLSearchParams({
      branch: "user/alice/wip",
      old_path: "old.md",
      path: "new.md",
      content: "# Renamed\n",
    });
    const res = await appFor(db).request("/owner/w/_edit", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(500);
    expect(calls).toEqual(["create-new", "delete-old"]);
  });

  it("renders and enforces a freshness token for file delete forms", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    let deleted = false;
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/git/trees/:ref", () => Response.json({ tree: [{ path: "notes.md", type: "blob" }], truncated: false }));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", () => new Response("# Notes\n"));
        forge.post("/api/v1/repos/owner/w/markdown", () => Response.json({ html: "<h1>Notes</h1>" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => {
          deleted = true;
          return Response.json({});
        });
      }),
    );

    const page = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      headers: authHeaders(token),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="expected_sha" value="current-sha"');

    const staleForm = new URLSearchParams({ action: "delete", expected_sha: "old-sha" });
    const stale = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: staleForm.toString(),
    });

    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("This file changed on the branch while you were viewing it");
    expect(deleted).toBe(false);
  });

  it("publishes a change event after browser file delete", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    const events: unknown[] = [];
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => new Response(null, { status: 204 }));
        forge.get("/api/v1/repos/owner/w/raw/notes.md", (c) => {
          expect(c.req.query("ref")).toBe("main");
          return new Response("not found", { status: 404 });
        });
      }),
    );
    const app = testApp(db, config, (hono) => {
      hono.use("*", (c, next) => {
        c.get("sse").subscribe("owner/w", (event) => events.push(event));
        return next();
      });
      registerFileRoutes(hono);
    });

    const form = new URLSearchParams({ action: "delete", expected_sha: "current-sha" });
    const res = await app.request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(events).toContainEqual({ type: "change", path: "notes.md" });
  });

  it("keeps main sidecar rows after browser file delete removes branch markdown", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db, { default_md_format: COFLAT_FORMAT_ID });
    indexPage(db, {
      workspaceSlug: "owner/w",
      filePath: "notes.md",
      bodyText: "---\nid: notes\n---\n# Notes\n",
      formatId: COFLAT_FORMAT_ID,
    });
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(
      fakeForgejo((forge) => {
        forge.get("/api/v1/repos/owner/w/branches", () => Response.json([{ name: "main" }, { name: "user/alice/wip" }]));
        forge.get("/api/v1/repos/owner/w/contents/notes.md", () => Response.json({ sha: "current-sha" }));
        forge.delete("/api/v1/repos/owner/w/contents/notes.md", () => new Response(null, { status: 204 }));
      }),
    );

    const form = new URLSearchParams({ action: "delete", expected_sha: "current-sha" });
    const res = await appFor(db).request("/owner/w/src/branch/user/alice/wip/notes.md", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(db.prepare("SELECT COUNT(*) AS n FROM doc_map WHERE workspace_slug = ?").get("owner/w")).toEqual({ n: 1 });
  });

  it("does not silently succeed when browser branch delete fails upstream", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.delete("/api/v1/repos/owner/w/branches/user%2Falice%2Fwip", () => new Response("forgejo down", { status: 500 }));
    }));

    const form = new URLSearchParams({ name: "user/alice/wip" });
    const res = await appFor(db).request("/owner/w/branches/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
  });

  it("treats an already-deleted browser branch as gone", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.delete("/api/v1/repos/owner/w/branches/user%2Falice%2Fwip", () => new Response("not found", { status: 404 }));
    }));

    const form = new URLSearchParams({ name: "user/alice/wip", redirect_to: "/owner/w/src/branch/main/notes.md" });
    const res = await appFor(db).request("/owner/w/branches/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/src/branch/main/notes.md");
  });

  it("ignores a browser branch delete redirect outside the repo", async () => {
    const db = freshTestDb("cosheaf-web-files-");
    seedTestWorkspace(db);
    const token = seedAuthUser(db, config, { username: "alice", role: "write" });
    fetchMock.mockImplementation(fakeForgejo((forge) => {
      forge.delete("/api/v1/repos/owner/w/branches/user%2Falice%2Fwip", () => new Response(null, { status: 204 }));
    }));

    const form = new URLSearchParams({ name: "user/alice/wip", redirect_to: "/other/repo/src/branch/main/notes.md" });
    const res = await appFor(db).request("/owner/w/branches/delete", {
      method: "POST",
      headers: formHeaders(token),
      body: form.toString(),
    });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/w/branches");
  });
});
