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
  it("edits an issue comment by id without an issue number", async () => {
    const fake = recordingFetch(() =>
      Response.json({ id: 55, body: "updated", author_username: "alice", created_at: 0, updated_at: 0 }),
    );
    const shape = await clientWith(fake.fetch).editIssueComment("me", "notes", 55, "updated");

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/issues/comments/55");
    expect(fake.calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ body: "updated" });
    expect(shape).toMatchObject({ id: 55, body: "updated", user: { login: "alice" } });
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

  it("treats a 404 on delete as success (idempotent)", async () => {
    const fake = recordingFetch(() => new Response("gone", { status: 404 }));
    await expect(clientWith(fake.fetch).deleteRepo("me", "notes")).resolves.toBeUndefined();
  });

  it("adds an inline comment to a pending review via the position-form route", async () => {
    const fake = recordingFetch(() => Response.json({ ok: true }));
    const shape = await clientWith(fake.fetch).addCommentToReview("me", "notes", 4, 9, {
      path: "doc.md",
      body: "nit",
      new_position: 12,
    });

    expect(fake.calls[0]?.input).toBe("https://core.example/api/v1/repos/me/notes/pulls/4/pending-review/9/review-comments");
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(fake.calls[0]?.init?.body))).toEqual({ path: "doc.md", body: "nit", new_position: 12 });
    expect(shape).toMatchObject({ path: "doc.md", body: "nit", position: 12, pull_request_review_id: 9 });
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
    expect(thread).toMatchObject({ id: 101, repository: { full_name: "me/notes" } });
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

  it("creates a single-comment review via pending-review → comment → submit", async () => {
    const fake = recordingFetch((call) =>
      call.input.endsWith("/pending-review") ? Response.json({ review_id: 9 }) : Response.json({ ok: true }),
    );
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
    expect(review).toMatchObject({ id: 9, state: "COMMENT" });
  });

  // BUG E round-trip: the core's GET /reviews surfaces the caller's own draft as
  // decision "pending"; listReviews must re-expand it to a PENDING ReviewShape so
  // findOrCreatePendingReview / requireOwnPendingReview can resolve the draft.
  it("maps the caller's own pending draft (decision 'pending') back to a PENDING review", async () => {
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
    expect(reviews.find((r) => r.id === 9)).toMatchObject({ state: "PENDING", user: { login: "me" } });
    expect(reviews.find((r) => r.id === 3)).toMatchObject({ state: "APPROVED" });
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
