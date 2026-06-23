import { describe, expect, it } from "vitest";
import {
  queryString,
  rawRepoBranchFileHref,
  repoBranchFileHref,
  repoHref,
  userHref,
  workspaceApiPath,
} from "./url.js";

describe("shared URL helpers", () => {
  it("builds encoded repository and user hrefs", () => {
    expect(repoHref("cha o", "math/repo", "/settings")).toBe("/cha%20o/math%2Frepo/settings");
    expect(userHref("cha o")).toBe("/users/cha%20o");
  });

  it("preserves branch and file path separators while encoding each segment", () => {
    expect(repoBranchFileHref("chao", "cogirth", "agent/wip-1", "notes/data sheet.md")).toBe(
      "/chao/cogirth/src/branch/agent/wip-1/notes/data%20sheet.md",
    );
    expect(rawRepoBranchFileHref("chao", "cogirth", "agent/wip-1", "figures/my figure(1).png")).toBe(
      "/chao/cogirth/raw/branch/agent/wip-1/figures/my%20figure(1).png",
    );
  });

  it("builds API paths and query strings with omitted empty fields", () => {
    expect(workspaceApiPath("cha o", "math/repo")).toBe("/api/v1/repos/cha%20o/math%2Frepo");
    expect(queryString({ branch: "agent/wip-1", limit: 10, empty: undefined, none: null, enabled: false })).toBe(
      "?branch=agent%2Fwip-1&limit=10&enabled=false",
    );
    expect(queryString({ empty: undefined })).toBe("");
  });
});
