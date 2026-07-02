import { describe, expect, it } from "vitest";
import { forgeActivitiesToRows } from "./activity-feed.js";
import type { ForgejoActivity } from "./forgejo-types.js";

function activity(overrides: Partial<ForgejoActivity>): ForgejoActivity {
  return {
    id: overrides.id ?? 1,
    op_type: overrides.op_type ?? "commit_repo",
    act_user: overrides.act_user ?? { id: 1, login: "alice" },
    ref_name: overrides.ref_name,
    content: overrides.content,
    comment: overrides.comment,
    created: overrides.created ?? "2026-06-01T00:00:00Z",
  };
}

describe("forgeActivitiesToRows", () => {
  it("collapses adjacent edit branch commits into repeat counts", () => {
    expect(
      forgeActivitiesToRows([
        activity({ id: 3, ref_name: "refs/heads/user/alice/wip", content: JSON.stringify({ Commits: [{ Sha1: "cccc", Message: "three" }] }) }),
        activity({ id: 2, ref_name: "refs/heads/user/alice/wip", content: JSON.stringify({ Commits: [{ Sha1: "bbbb", Message: "two" }] }) }),
        activity({ id: 1, ref_name: "refs/heads/user/alice/wip", content: JSON.stringify({ Commits: [{ Sha1: "aaaa", Message: "one" }] }) }),
        activity({ id: 4, ref_name: "refs/heads/main", content: JSON.stringify({ Commits: [{ Sha1: "dddd", Message: "main" }] }) }),
      ]),
    ).toMatchObject([
      { id: 3, commit_sha: "cccc", commit_message: "three", repeat_count: 3 },
      { id: 4, commit_sha: "dddd", commit_message: "main", repeat_count: 1 },
    ]);
  });

  it("parses strict positive reference indexes and keeps tuple text neutral", () => {
    expect(
      forgeActivitiesToRows([
        activity({ id: 1, op_type: "create_pull_request", content: JSON.stringify(["42", "feature-branch"]) }),
        activity({ id: 2, op_type: "create_issue", content: JSON.stringify(["1e2", "bad"]) }),
        activity({ id: 3, op_type: "create_issue", content: JSON.stringify(["7.0", "bad"]) }),
      ]),
    ).toMatchObject([
      { id: 1, ref_index: 42, ref_text: "feature-branch" },
      { id: 2, ref_index: null, ref_text: "bad" },
      { id: 3, ref_index: null, ref_text: "bad" },
    ]);
  });

  it("falls back to Forgejo issue comment URLs when content has no index", () => {
    expect(
      forgeActivitiesToRows([
        activity({
          id: 7,
          op_type: "comment_issue",
          comment: { id: 11, body: "noted", issue_url: "http://forgejo.test/api/v1/repos/owner/w/issues/9" },
        }),
      ]),
    ).toMatchObject([{ id: 7, ref_index: 9 }]);
  });
});
