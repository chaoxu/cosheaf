import { describe, expect, it } from "vitest";
import {
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
});

describe("localMemberSetter", () => {
  it("throws NoCoreConnectedError for an unconnected workspace", () => {
    const setMember = localMemberSetter({ remote: null } as unknown as WorkspaceEntry, "me", "notes");
    expect(() => setMember("vera", "write")).toThrow(NoCoreConnectedError);
  });
});
