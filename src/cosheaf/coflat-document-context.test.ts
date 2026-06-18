import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CoflatDocumentPayload,
  loadCoflatRefs,
  resolveMathMacros,
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
});
