import { describe, expect, it } from "vitest";
import { parseSeedOptions } from "./cli.js";

describe("cli seed parsing", () => {
  it("parses required seed flags and defaults workspace name to slug", () => {
    expect(parseSeedOptions([
      "--user",
      "chao",
      "--password=123123",
      "--workspace",
      "notes",
    ])).toEqual({
      user: "chao",
      password: "123123",
      workspace: "notes",
      workspaceName: "notes",
      defaultMdFormat: "forgejo-passthrough",
    });
  });

  it("accepts --default-md-format=forgejo-passthrough", () => {
    expect(parseSeedOptions([
      "--user", "chao", "--password=pw", "--workspace", "notes",
      "--default-md-format", "forgejo-passthrough",
    ])).toMatchObject({ defaultMdFormat: "forgejo-passthrough" });
  });

  it("rejects unknown markdown formats", () => {
    expect(() => parseSeedOptions([
      "--user", "chao", "--password=pw", "--workspace", "notes",
      "--default-md-format", "bogus",
    ])).toThrow("--default-md-format must be a known DocumentFormatId");
  });

  it("rejects missing values and invalid workspace slugs", () => {
    expect(() => parseSeedOptions(["--user", "--password", "pw", "--workspace", "notes"]))
      .toThrow("seed requires --user");
    expect(() => parseSeedOptions(["--user", "chao", "--password", "pw", "--workspace", "Bad"]))
      .toThrow("workspace must match");
  });
});
