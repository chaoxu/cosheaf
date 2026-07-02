import { describe, expect, it } from "vitest";
import {
  localCollaborationClient,
  localMemberSetter,
  NoCoreConnectedError,
  OriginCollaborationClient,
} from "./origin-collaboration-client.js";
import type { WorkspaceEntry } from "./workspace-registry.js";

interface FetchCall {
  input: string;
  init?: RequestInit;
}

function recordingFetch(responseFor: (call: FetchCall) => Response): {
  calls: FetchCall[];
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const call = { input, init };
      calls.push(call);
      return responseFor(call);
    },
  };
}

function clientWith(fetch: (input: string, init?: RequestInit) => Promise<Response>): OriginCollaborationClient {
  return new OriginCollaborationClient("https://core.example/", "tok", { fetch });
}

describe("OriginCollaborationClient write methods", () => {
  it("reads the authenticated Core user through /api/v1/me", async () => {
    const fake = recordingFetch(() => Response.json({ user: { username: "alice" } }));

    await expect(clientWith(fake.fetch).whoami()).resolves.toEqual({ username: "alice" });
    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/me");
    expect(fake.calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(fake.calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("edits an issue comment by id without an issue number", async () => {
    const fake = recordingFetch(() =>
      Response.json({ id: 55, body: "updated", author_username: "alice", created_at: 0, updated_at: 0 }),
    );
    const shape = await clientWith(fake.fetch).editIssueComment("me", "notes", 55, "updated");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues/comments/55");
    expect(fake.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ body: "updated" });
    expect(shape).toMatchObject({ id: 55, body: "updated", author_username: "alice" });
  });

  it("deletes an issue comment by id without an issue number", async () => {
    const fake = recordingFetch(() => new Response(null, { status: 204 }));
    await clientWith(fake.fetch).deleteIssueComment("me", "notes", 55);

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues/comments/55");
    expect(fake.calls[0]?.init?.method).toBe("DELETE");
  });

  it("replaces the repo topic set", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).replaceRepoTopics("me", "notes", ["cosheaf-format-coflat", "math"]);

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/topics");
    expect(fake.calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ topics: ["cosheaf-format-coflat", "math"] });
  });

  it("removes a collaborator through the members route", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true, username: "vera" }));
    await clientWith(fake.fetch).removeCollaborator("me", "notes", "vera");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/members/vera");
    expect(fake.calls[0]?.init?.method).toBe("DELETE");
  });

  it("sets a collaborator role through the members route", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true, username: "vera", role: "write" }));
    await clientWith(fake.fetch).setMember("me", "notes", "vera", "write");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/members/vera");
    expect(fake.calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ role: "write" });
  });

  it("patches repo metadata, forwarding only set fields", async () => {
    const fake = recordingFetch(() =>
      Response.json({ full_name: "me/notes", description: "new", private: true, default_branch: "trunk" }),
    );
    const shape = await clientWith(fake.fetch).editRepo("me", "notes", { description: "new", default_branch: "trunk" });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes");
    expect(fake.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ description: "new", default_branch: "trunk" });
    expect(shape).toMatchObject({ description: "new", default_branch: "trunk" });
  });

  it("deletes a repo", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).deleteRepo("me", "notes");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes");
    expect(fake.calls[0]?.init?.method).toBe("DELETE");
  });

  it("preserves core activity repeat counts", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        activities: [
          {
            id: 8,
            op_type: "commit_repo",
            author_username: "vera",
            ref_index: null,
            ref_name: "refs/heads/user/vera/wip",
            ref_text: null,
            commit_sha: "abc123",
            commit_message: "update notes",
            repeat_count: 4,
            created_at: 1_780_000_000_000,
          },
        ],
      }),
    );

    await expect(clientWith(fake.fetch).listRepoActivities("me", "notes")).resolves.toMatchObject([
      { id: 8, author_username: "vera", repeat_count: 4, commit_sha: "abc123" },
    ]);
  });

  it("does not apply main-branch review policy to non-main branches", async () => {
    const fake = recordingFetch(() => Response.json({ min_approvals: 2 }));
    await expect(clientWith(fake.fetch).getBranchProtection("me", "notes", "release")).resolves.toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("forwards issue assignees through the typed issue patch route", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        number: 3,
        title: "Bug",
        body: "body",
        state: "open",
        author_username: "me",
        assignees: ["vera"],
        labels: [],
        milestone: null,
        comment_count: 0,
        created_at: 0,
        updated_at: 0,
        closed_at: null,
      }),
    );
    const detail = await clientWith(fake.fetch).editIssue("me", "notes", 3, {
      title: "Bug",
      body: "body",
      assignees: ["vera"],
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues/3");
    expect(fake.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ title: "Bug", body: "body", assignees: ["vera"] });
    expect(detail.assignees).toEqual(["vera"]);
  });

  it("creates issues from the typed route's compact create result", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        number: 6,
        title: "Bug",
        state: "open",
      }),
    );
    const detail = await clientWith(fake.fetch).createIssue("me", "notes", {
      title: "Bug",
      body: "body",
      labels: [4],
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues");
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ title: "Bug", body: "body", labels: [4] });
    expect(detail).toEqual({ number: 6, title: "Bug", state: "open" });
  });

  it("forwards PR milestones through the typed pull patch route", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        pull: {
          number: 4,
          title: "PR",
          body: "body",
          state: "open",
          merged: false,
          author_username: "me",
          created_at: 0,
          merged_at: null,
          mergeable: true,
          head_ref: "topic",
          head_sha: "h",
          base_ref: "main",
          base_sha: "b",
          additions_total: 0,
          deletions_total: 0,
          files_changed: 0,
          comment_count: 0,
          labels: [],
          milestone: { id: 7, title: "v1" },
          requested_reviewers: [],
          requested_reviewer_teams: [],
        },
      }),
    );
    const pull = await clientWith(fake.fetch).editPull("me", "notes", 4, {
      title: "PR",
      milestone: 7,
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/pulls/4");
    expect(fake.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ title: "PR", milestone: 7 });
    expect(pull.milestone).toEqual({ id: 7, title: "v1" });
  });

  it("treats a 404 on delete as success (idempotent)", async () => {
    const fake = recordingFetch(() => new Response("gone", { status: 404 }));
    await expect(clientWith(fake.fetch).deleteRepo("me", "notes")).resolves.toBeUndefined();
  });

  it("adds an inline comment to a pending review via the position-form route", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).addCommentToReview("me", "notes", 4, 9, {
      path: "doc.md",
      body: "nit",
      new_position: 12,
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/review-comments");
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ path: "doc.md", body: "nit", new_position: 12 });
  });

  it("removes an issue block edge with the blocking number in the body", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).removeIssueBlock("me", "notes", 3, 7);

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues/3/blocks");
    expect(fake.calls[0]?.init?.method).toBe("DELETE");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ index: 7 });
  });

  it("resolves a single notification thread by its global id", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        notification: {
          id: 101,
          kind: "issue",
          number: 42,
          title: "Bug A",
          repo: "me/notes",
          updated_at: 0,
          url: "http://core/me/notes/issues/42",
        },
      }),
    );
    const thread = await clientWith(fake.fetch).getNotificationThread(101);

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/notifications/threads/101");
    expect(fake.calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(thread).toMatchObject({ id: 101, repo: "me/notes", kind: "issue", number: 42 });
  });

  it("marks a single notification thread read by its global id", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).markNotificationRead(101);

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/notifications/101/read");
    expect(fake.calls[0]?.init?.method).toBe("POST");
  });

  it("marks every thread in a repo read through the repo read-all route", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    await clientWith(fake.fetch).markRepoNotificationsRead("me", "notes");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/notifications/read-all");
    expect(fake.calls[0]?.init?.method).toBe("POST");
  });

  it("returns login-only collaborator and reviewer rows", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        collaborators: [
          { login: "vera", permission: "write" },
          { login: "ada", permission: "read" },
        ],
      }),
    );
    const client = clientWith(fake.fetch);

    await expect(client.listCollaborators("me", "notes")).resolves.toEqual([{ login: "vera" }, { login: "ada" }]);
    await expect(client.listPullReviewers("me", "notes")).resolves.toEqual([{ login: "vera" }, { login: "ada" }]);
    expect(fake.calls.map((call) => call.input)).toEqual([
      "https://core.example/api/v1/repos/me/notes/collaborators",
      "https://core.example/api/v1/repos/me/notes/collaborators",
    ]);
  });

  it("creates a single-comment review via pending-review → comment → submit", async () => {
    const fake = recordingFetch((call) => {
      if (call.input.endsWith("/pending-review")) {
        return Response.json({ review_id: 9, review: { id: 9, username: "me", decision: "pending", comment: null, created_at: 10 } });
      }
      if (call.input.endsWith("/submit")) {
        return Response.json({ review: { id: 9, username: "me", decision: "comment", comment: null, created_at: 20 } });
      }
      return Response.json({ ok: true });
    });
    const review = await clientWith(fake.fetch).createReview("me", "notes", 4, {
      event: "COMMENT",
      body: "",
      comments: [{ path: "doc.md", body: "nit", new_position: 12 }],
    });

    expect(fake.calls.map((c) => c.input)).toEqual([
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review",
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/review-comments",
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/submit",
    ]);
    expect(JSON.parse(String(fake.calls[1]?.init?.body))).toEqual({ path: "doc.md", body: "nit", new_position: 12 });
    expect(JSON.parse(String(fake.calls[2]?.init?.body))).toEqual({ event: "comment", body: "" });
    expect(review).toMatchObject({ id: 9, username: "me", decision: "comment", created_at: 20 });
  });

  it("falls back to reading reviews when legacy review writes omit the DTO", async () => {
    const fake = recordingFetch((call) => {
      if (call.input.endsWith("/pending-review")) return Response.json({ review_id: 9 });
      if (call.input.endsWith("/submit")) return Response.json({ ok: true });
      if (call.input.endsWith("/reviews")) {
        return Response.json({
          reviews: [{ id: 9, username: "me", decision: "approve", comment: "ok", created_at: 30 }],
          approvals: 1,
          rejections: 0,
        });
      }
      return Response.json({ ok: true });
    });

    const review = await clientWith(fake.fetch).createReview("me", "notes", 4, {
      event: "APPROVED",
      body: "ok",
      comments: [{ path: "doc.md", body: "nit", new_position: 12 }],
    });

    expect(fake.calls.map((c) => c.input)).toEqual([
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review",
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/review-comments",
      "https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/submit",
      "https://core.example/api/v1/repos/me/notes/pulls/4/reviews",
    ]);
    expect(review).toEqual({ id: 9, username: "me", decision: "approve", comment: "ok", created_at: 30 });
  });

  it("returns direct review DTOs from typed review routes", async () => {
    const fake = recordingFetch(() =>
      Response.json({ review: { id: 12, username: "vera", decision: "approve", comment: "ok", created_at: 30 } }),
    );

    const review = await clientWith(fake.fetch).createReview("me", "notes", 4, {
      event: "APPROVED",
      body: "ok",
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/pulls/4/reviews");
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ event: "APPROVE", body: "ok" });
    expect(review).toEqual({ id: 12, username: "vera", decision: "approve", comment: "ok", created_at: 30 });
  });

  // BUG E round-trip: the core's GET /reviews surfaces the caller's own draft as
  // decision "pending"; listReviews must preserve it so findOrCreatePendingReview
  // / requireOwnPendingReview can resolve the draft.
  it("preserves the caller's own pending draft review DTO", async () => {
    const fake = recordingFetch(() =>
      Response.json({
        reviews: [
          { id: 3, username: "vera", decision: "approve", comment: "lgtm", created_at: 0 },
          { id: 9, username: "me", decision: "pending", comment: null, created_at: 0 },
        ],
        approvals: 1,
        rejections: 0,
      }),
    );
    const reviews = await clientWith(fake.fetch).listReviews("me", "notes", 4);
    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/pulls/4/reviews");
    expect(reviews.find((r) => r.id === 9)).toMatchObject({ decision: "pending", username: "me" });
    expect(reviews.find((r) => r.id === 3)).toMatchObject({ decision: "approve", username: "vera" });
  });
});

describe("localMemberSetter", () => {
  it("throws NoCoreConnectedError for an unconnected workspace", () => {
    const setMember = localMemberSetter({ remote: null } as unknown as WorkspaceEntry, "me", "notes");
    expect(() => setMember("vera", "write")).toThrow(NoCoreConnectedError);
  });
});

describe("getRepoPermission", () => {
  // The connected Origin client now implements the full CollaborationClient
  // surface (no unimplemented-stub Proxy). The core exposes no per-user
  // permission endpoint, so getRepoPermission resolves to "none" — which the sole
  // caller (the PR reviewer-permission column) maps to an empty cell — rather than
  // rejecting.
  it('resolves to "none" instead of rejecting', async () => {
    const client = localCollaborationClient({
      remote: { url: "https://core.example", token: "t" },
    } as unknown as WorkspaceEntry);
    await expect(client.getRepoPermission("me", "notes", "vera")).resolves.toBe("none");
  });
});
