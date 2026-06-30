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
});

describe("localMemberSetter", () => {
  it("throws NoCoreConnectedError for an unconnected workspace", () => {
    const setMember = localMemberSetter({ remote: null } as unknown as WorkspaceEntry, "me", "notes");
    expect(() => setMember("vera", "write")).toThrow(NoCoreConnectedError);
  });
});

describe("unimplemented stubs", () => {
  // Regression: a not-yet-backed method (e.g. getRepoPermission) must reject
  // ASYNCHRONOUSLY, never throw synchronously. Call sites wrap optional methods
  // in `.catch(() => [])` (the PR page's listPullReviewers); a sync throw fires
  // before the promise exists, so `.catch` can't attach and the page 500s.
  it("reject asynchronously so .catch can degrade", async () => {
    const client = localCollaborationClient({
      remote: { url: "https://core.example", token: "t" },
    } as unknown as WorkspaceEntry);
    const result = (client.getRepoPermission as (...a: unknown[]) => unknown)("me", "notes", "vera");
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toThrow(/not implemented/);
    await expect(
      (client.getRepoPermission as (...a: unknown[]) => Promise<unknown>)("me", "notes", "vera").catch(() => "ok"),
    ).resolves.toBe("ok");
  });
});
