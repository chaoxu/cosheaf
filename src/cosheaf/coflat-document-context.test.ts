import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coflatDocumentContext,
  type CoflatDocumentPayload,
  loadCoflatRefs,
  resolveMathMacros,
  resolveRawRepoDisplayAssetLink,
  resolveRawRepoLink,
  resolveRepoLink,
} from "./coflat-document-context";

const payload: CoflatDocumentPayload = {
  source: "",
  owner: "chao",
  repo: "poa-network-game",
  branch: "main",
  path: "notes/current.md",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveMathMacros (repo-wide macros + per-doc override, #183)", () => {
  it("uses the repo macros when the doc has none", () => {
    expect(resolveMathMacros({ ...payload, mathMacros: { "\\R": "\\mathbb{R}" } })).toEqual({ "\\R": "\\mathbb{R}" });
  });

  it("lets a doc's own frontmatter math override the repo per key", () => {
    expect(
      resolveMathMacros({
        ...payload,
        mathMacros: { "\\R": "\\mathbb{R}", "\\norm": "\\lVert#1\\rVert" },
        source: "---\nmath:\n  '\\R': '\\mathbb{Q}'\n---\n# doc\n",
      }),
    ).toEqual({ "\\R": "\\mathbb{Q}", "\\norm": "\\lVert#1\\rVert" });
  });

  it("works with no repo macros (doc-only) and ignores non-string frontmatter math", () => {
    expect(resolveMathMacros({ ...payload, source: "---\nmath:\n  '\\Z': '\\mathbb{Z}'\n  bad: 5\n---\nx\n" })).toEqual({
      "\\Z": "\\mathbb{Z}",
    });
    expect(resolveMathMacros(payload)).toEqual({});
  });
});

describe("resolveRepoLink", () => {
  it("routes source line fragments to the source view", () => {
    expect(resolveRepoLink(payload, "undirected-sp-underlay.md#L1-52")).toBe(
      "/chao/poa-network-game/src/branch/main/notes/undirected-sp-underlay.md?view=source#L1-52",
    );
    expect(resolveRepoLink(payload, "../model.md#L4-L8")).toBe(
      "/chao/poa-network-game/src/branch/main/model.md?view=source#L4-L8",
    );
  });

  it("leaves semantic fragments on the rendered document view", () => {
    expect(resolveRepoLink(payload, "directed-ttsp.md#sec:status")).toBe(
      "/chao/poa-network-game/src/branch/main/notes/directed-ttsp.md#sec%3Astatus",
    );
  });

  it("keeps raw repo links free of source-view query parameters", () => {
    expect(resolveRawRepoLink(payload, "undirected-sp-underlay.md#L1-52")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/undirected-sp-underlay.md#L1-52",
    );
  });

  it("decodes markdown URL escapes once before building repo routes", () => {
    expect(resolveRepoLink(payload, "assets/data%20sheet.pdf")).toBe(
      "/chao/poa-network-game/src/branch/main/notes/assets/data%20sheet.pdf",
    );
    expect(resolveRawRepoLink(payload, "assets/my%20figure(1%29.png")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/assets/my%20figure(1).png",
    );
  });

  it("uses preview images only for raw asset URLs", () => {
    const withPreviews = {
      ...payload,
      assetPreviewPaths: { "notes/figures/pipeline.pdf": "notes/figures/pipeline.png" },
    };
    expect(resolveRawRepoLink(withPreviews, "figures/pipeline.pdf")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.pdf",
    );
    expect(resolveRawRepoDisplayAssetLink(withPreviews, "figures/pipeline.pdf")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.png",
    );
  });

  it("uses main for raw asset URLs when the edit branch does not exist yet", () => {
    const freshEditPayload = {
      ...payload,
      branch: "user/chao/new-edit",
      branchExists: false,
      assetPreviewPaths: { "notes/figures/pipeline.pdf": "notes/figures/pipeline.png" },
    };
    expect(resolveRawRepoLink(freshEditPayload, "figures/pipeline.pdf")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.pdf",
    );
    expect(resolveRawRepoDisplayAssetLink(freshEditPayload, "figures/pipeline.pdf")).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.png",
    );
  });

  it("resolves Coflat file-system asset paths as workspace-relative", () => {
    const context = coflatDocumentContext({
      ...payload,
      assetPreviewPaths: { "notes/figures/pipeline.pdf": "notes/figures/pipeline.png" },
    }, { workspaceCrossrefs: new Map(), citations: null });
    const fileSystem = context.fileSystem;
    expect(fileSystem).toBeDefined();

    expect(fileSystem?.resolveAssetUrl("notes/figures/pipeline.pdf", { purpose: "source" })).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.pdf",
    );
    expect(fileSystem?.resolveAssetUrl("notes/figures/pipeline.pdf", { purpose: "display" })).toBe(
      "/chao/poa-network-game/raw/branch/main/notes/figures/pipeline.png",
    );
  });
});

describe("loadCoflatRefs", () => {
  it("leaves local crossrefs to Coflat and loads only workspace refs", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("ids=page%3Aremote");
      expect(url).not.toContain("thm%3Alocal");
      return new Response(JSON.stringify({
        refs: [
          {
            id: "page:remote",
            path: "remote.md",
            kind: "page",
            label: "Remote page",
            fragment: "page:remote",
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await loadCoflatRefs({
      ...payload,
      source: [
        "::: {.theorem #thm:local}",
        "Local theorem.",
        ":::",
        "",
        "See [@thm:local] and [@page:remote].",
      ].join("\n"),
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(refs.workspaceCrossrefs.has("thm:local")).toBe(false);
    expect(refs.workspaceCrossrefs.get("page:remote")).toEqual({
      label: "Remote page",
      href: "/chao/poa-network-game/src/branch/main/remote.md#page%3Aremote",
    });
  });

  it("loads workspace refs from the document ref when rendering a non-main snapshot", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("ids=thm%3Abranch");
      expect(url).toContain("ref=abc123");
      return new Response(JSON.stringify({
        refs: [
          {
            id: "thm:branch",
            path: "branch.md",
            kind: "block",
            label: "Theorem 7",
            fragment: "thm:branch",
          },
        ],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await loadCoflatRefs({
      ...payload,
      branch: "abc123",
      source: "See [@thm:branch].",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(refs.workspaceCrossrefs.get("thm:branch")).toEqual({
      label: "Theorem 7",
      href: "/chao/poa-network-game/src/branch/abc123/branch.md#thm%3Abranch",
    });
  });

  it("does not request branch refs for a missing edit branch", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("ids=thm%3Abranch");
      expect(url).not.toContain("ref=");
      return new Response(JSON.stringify({ refs: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadCoflatRefs({
      ...payload,
      branch: "user/alice/new",
      branchExists: false,
      source: "See [@thm:branch].",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves built-in CSL names without fetching them as repo files", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/refs?ids=")) return new Response(JSON.stringify({ refs: [] }), { status: 200 });
      if (url.endsWith("/refs.bib")) {
        return new Response([
          "@article{karger2000,",
          "  author = {Karger, David R.},",
          "  title = {Minimum Cuts},",
          "  journal = {JACM},",
          "  year = {2000}",
          "}",
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await loadCoflatRefs({
      ...payload,
      bibliography: "refs.bib",
      csl: "ieee",
      source: "See [@karger2000].",
    });

    expect(refs.citations?.keys.has("karger2000")).toBe(true);
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.endsWith("/ieee"))).toBe(false);
  });

  it("registers CSL citations in document order for numeric labels and bibliography entries", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/refs?ids=")) return new Response(JSON.stringify({ refs: [] }), { status: 200 });
      if (url.endsWith("/refs.bib")) {
        return new Response([
          "@article{alpha2020,",
          "  author = {Alpha, Alice},",
          "  title = {First Paper},",
          "  journal = {JACM},",
          "  year = {2020}",
          "}",
          "",
          "@article{beta2021,",
          "  author = {Beta, Bob},",
          "  title = {Second Paper},",
          "  journal = {SICOMP},",
          "  year = {2021}",
          "}",
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await loadCoflatRefs({
      ...payload,
      bibliography: "refs.bib",
      csl: "ieee",
      source: "See [@beta2021] before [@alpha2020].",
    });

    expect(refs.citations?.formatter.cite(["beta2021"], [undefined])).toContain("[1]");
    expect(refs.citations?.formatter.cite(["alpha2020"], [undefined])).toContain("[2]");
    const bibliography = refs.citations?.formatter.bibliographyEntries(["beta2021", "alpha2020"]);
    expect(bibliography?.map((entry) => entry.id)).toEqual(["beta2021", "alpha2020"]);
    expect(bibliography?.[0]?.html).toContain("Second Paper");
    expect(bibliography?.[1]?.html).toContain("First Paper");
  });

  it("keeps document citation numbering after a preview registers a subset", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/refs?ids=")) return new Response(JSON.stringify({ refs: [] }), { status: 200 });
      if (url.endsWith("/refs.bib")) {
        return new Response([
          "@article{alpha2020,",
          "  author = {Alpha, Alice},",
          "  title = {First Paper},",
          "  journal = {JACM},",
          "  year = {2020}",
          "}",
          "",
          "@article{beta2021,",
          "  author = {Beta, Bob},",
          "  title = {Second Paper},",
          "  journal = {SICOMP},",
          "  year = {2021}",
          "}",
        ].join("\n"));
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await loadCoflatRefs({
      ...payload,
      bibliography: "refs.bib",
      csl: "ieee",
      source: "See [@alpha2020] before [@beta2021].",
    });
    const formatter = refs.citations?.formatter;

    expect(formatter?.cite(["beta2021"], [undefined])).toContain("[2]");
    formatter?.registerCitations([{ ids: ["beta2021"], locators: [undefined] }]);
    expect(formatter?.cite(["beta2021"], [undefined])).toContain("[2]");
  });
});
