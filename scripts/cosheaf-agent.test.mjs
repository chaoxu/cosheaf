import { describe, expect, it } from "vitest";
import {
  loadPrFiles,
  normalizeApiBase,
  parseFileSpec,
  parseWorkspace,
  prFromFiles,
  tokenFromOptions,
} from "./cosheaf-agent.mjs";

describe("cosheaf-agent", () => {
  it("parses owner/repo workspaces", () => {
    expect(parseWorkspace("chao/flushing-coin")).toEqual({
      owner: "chao",
      repo: "flushing-coin",
      slug: "chao/flushing-coin",
    });
    expect(() => parseWorkspace("flushing-coin")).toThrow("--workspace must be <owner>/<repo>");
  });

  it("parses file specs with optional local path mapping", () => {
    expect(parseFileSpec("notes/a.md")).toEqual({
      workspacePath: "notes/a.md",
      localPath: "notes/a.md",
    });
    expect(parseFileSpec("notes/a.md=/tmp/a.md")).toEqual({
      workspacePath: "notes/a.md",
      localPath: "/tmp/a.md",
    });
    expect(() => parseFileSpec("../secret.md")).toThrow("Invalid workspace path");
    expect(() => parseFileSpec("/secret.md")).toThrow("Invalid workspace path");
  });

  it("loads PR files through an injectable reader", () => {
    const files = loadPrFiles(["notes/a.md=local/a.md"], (path) => `read:${path}`);
    expect(files).toEqual([
      {
        workspacePath: "notes/a.md",
        localPath: "local/a.md",
        content: "read:local/a.md",
      },
    ]);
  });

  it("normalizes API URLs and token sources", () => {
    expect(normalizeApiBase("http://127.0.0.1:3030/api/v1/")).toBe("http://127.0.0.1:3030/api/v1");
    expect(tokenFromOptions({}, { COSHEAF_TOKEN: "token-1" })).toBe("token-1");
    expect(tokenFromOptions({}, { COSHEAF_PAT: "pat-1" })).toBe("pat-1");
    expect(tokenFromOptions({ token: "token-2" }, { COSHEAF_TOKEN: "token-1" })).toBe("token-2");
    expect(() => tokenFromOptions({}, {})).toThrow("A Cosheaf API token is required");
  });

  it("builds a dry-run PR plan without calling Cosheaf", async () => {
    const result = await prFromFiles({
      api: "http://127.0.0.1:3030/api/v1/",
      workspace: "chao/flushing-coin",
      branch: "agent/wip",
      base: "main",
      title: "Update notes",
      file: ["notes/a.md=docs/AI_CLIENTS.md"],
      dryRun: true,
    });
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      api: "http://127.0.0.1:3030/api/v1",
      workspace: "chao/flushing-coin",
      branch: "agent/wip",
      base: "main",
      title: "Update notes",
      files: [{ path: "notes/a.md", localPath: "docs/AI_CLIENTS.md" }],
    });
  });
});
