import { describe, expect, it } from "vitest";
import { parseSeedOptions } from "./cli.js";

describe("cli seed parsing", () => {
  it("parses required seed flags and defaults workspace name to the repo name", () => {
    expect(parseSeedOptions([
      "--user",
      "chao",
      "--password=123123",
      "--workspace",
      "chao/notes",
    ])).toEqual({
      user: "chao",
      password: "123123",
      owner: "chao",
      repo: "notes",
      workspaceName: "notes",
      defaultMdFormat: "forgejo-passthrough",
      profile: "all",
    });
  });

  it("accepts --default-md-format=forgejo-passthrough and seed profiles", () => {
    expect(parseSeedOptions([
      "--user", "chao", "--password=pw", "--workspace", "chao/notes",
      "--default-md-format", "forgejo-passthrough",
      "--profile", "rendering",
    ])).toMatchObject({ defaultMdFormat: "forgejo-passthrough", profile: "rendering" });
  });

  it("rejects unknown markdown formats", () => {
    expect(() => parseSeedOptions([
      "--user", "chao", "--password=pw", "--workspace", "chao/notes",
      "--default-md-format", "bogus",
    ])).toThrow("--default-md-format must be a known DocumentFormatId");
  });

  it("rejects unknown seed profiles", () => {
    expect(() => parseSeedOptions([
      "--user", "chao", "--password=pw", "--workspace", "chao/notes",
      "--profile", "huge",
    ])).toThrow("--profile must be one of");
  });

  it("rejects missing values and invalid workspace slugs", () => {
    expect(() => parseSeedOptions(["--user", "--password", "pw", "--workspace", "chao/notes"]))
      .toThrow("required option '--password <password>' not specified");
    // Ownerless bare slugs are gone — the workspace is always <owner>/<repo>.
    expect(() => parseSeedOptions(["--user", "chao", "--password", "pw", "--workspace", "notes"]))
      .toThrow("--workspace must be <owner>/<repo>");
    // The repo half stays cosheaf-opinionated (lowercase, dashes).
    expect(() => parseSeedOptions(["--user", "chao", "--password", "pw", "--workspace", "chao/Bad"]))
      .toThrow("workspace repo name must match");
  });
});
