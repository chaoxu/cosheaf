import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteWorkspaceRepoAndSidecar, parseSeedOptions } from "./cli.js";
import { ForgejoError } from "./forgejo.js";
import { freshTestDb } from "./routes/test-fixtures.js";
import { _clearTreeCacheForTests, getCachedTree, setCachedTree } from "./tree-cache.js";

afterEach(() => {
  _clearTreeCacheForTests();
});

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
      defaultMdFormat: "coflat",
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

describe("cli workspace rm cleanup", () => {
  it("clears sidecar rows even when the Forgejo repo is already gone", async () => {
    const db = freshTestDb("cosheaf-cli-rm-");
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("page", "owner/w", "page.md", "Page", Date.now());
    db.prepare(
      "INSERT INTO backlinks (workspace_slug, src_id, src_path, target_id, target_label, line) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("owner/w", "page", "page.md", null, "external", 1);
    db.prepare("INSERT INTO page_tags (workspace_slug, cosheaf_id, tag) VALUES (?, ?, ?)").run("owner/w", "page", "tag");
    db.prepare(
      "INSERT INTO issue_claims (id, workspace_slug, issue_number, runner_name, purpose, holder_username, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("claim-1", "owner/w", 7, "agent", "triage", "alice", 1, 1, Date.now() + 60_000);
    setCachedTree("owner", "w", "main", [{ path: "page.md", type: "blob", sha: "tree-sha" }]);
    setCachedTree("owner", "other", "main", [{ path: "keep.md", type: "blob", sha: "other-sha" }]);

    const forgejo = {
      deleteRepo: vi.fn(async () => {
        throw new ForgejoError(404, "not found", "DELETE", "/api/v1/repos/owner/w");
      }),
    };

    await expect(deleteWorkspaceRepoAndSidecar({ db, forgejo, owner: "owner", repo: "w" }))
      .resolves.toBe("owner/w");
    expect(forgejo.deleteRepo).toHaveBeenCalledWith("owner", "w");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM backlinks WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM page_tags WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM issue_claims WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 0 });
    expect(getCachedTree("owner", "w", "main")).toBeUndefined();
    expect(getCachedTree("owner", "other", "main")).toEqual([{ path: "keep.md", type: "blob", sha: "other-sha" }]);
  });

  it("keeps sidecar rows when Forgejo delete fails for a non-404 reason", async () => {
    const db = freshTestDb("cosheaf-cli-rm-");
    db.prepare(
      "INSERT INTO doc_map (cosheaf_id, workspace_slug, forgejo_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("page", "owner/w", "page.md", "Page", Date.now());
    const forgejo = {
      deleteRepo: vi.fn(async () => {
        throw new ForgejoError(500, "boom", "DELETE", "/api/v1/repos/owner/w");
      }),
    };

    await expect(deleteWorkspaceRepoAndSidecar({ db, forgejo, owner: "owner", repo: "w" }))
      .rejects.toThrow("forgejo deleteRepo failed");
    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = 'owner/w'").get()).toEqual({ c: 1 });
  });
});
