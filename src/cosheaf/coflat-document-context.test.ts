import { describe, expect, it } from "vitest";
import { resolveRawRepoLink, resolveRepoLink, type CoflatDocumentPayload } from "./coflat-document-context";

const payload: CoflatDocumentPayload = {
  source: "",
  repo: "poa-network-game",
  branch: "main",
  path: "notes/current.md",
};

describe("resolveRepoLink", () => {
  it("routes source line fragments to the source view", () => {
    expect(resolveRepoLink(payload, "undirected-sp-underlay.md#L1-52")).toBe(
      "/poa-network-game/src/branch/main/notes/undirected-sp-underlay.md?view=source#L1-52",
    );
    expect(resolveRepoLink(payload, "../model.md#L4-L8")).toBe(
      "/poa-network-game/src/branch/main/model.md?view=source#L4-L8",
    );
  });

  it("leaves semantic fragments on the rendered document view", () => {
    expect(resolveRepoLink(payload, "directed-ttsp.md#sec:status")).toBe(
      "/poa-network-game/src/branch/main/notes/directed-ttsp.md#sec%3Astatus",
    );
  });

  it("keeps raw repo links free of source-view query parameters", () => {
    expect(resolveRawRepoLink(payload, "undirected-sp-underlay.md#L1-52")).toBe(
      "/poa-network-game/raw/branch/main/notes/undirected-sp-underlay.md#L1-52",
    );
  });
});
