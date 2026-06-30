import { describe, expect, it } from "vitest";
import { CosheafOriginClient, RemoteCosheafClient, RemoteCosheafError } from "./remote-cosheaf-client.js";

interface FetchCall {
  input: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

function fakeFetch(responseFor: (call: FetchCall) => Response | Promise<Response>): {
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

describe("CosheafOriginClient", () => {
  it("reads the authenticated user through /api/v1/me", async () => {
    const fake = fakeFetch(() => jsonResponse({ user: { username: "alice" } }));
    const client = new CosheafOriginClient("https://cosheaf.example/", "tok", { fetch: fake.fetch });

    await expect(client.me()).resolves.toEqual({ user: { username: "alice" } });
    await expect(client.whoami()).resolves.toEqual({ username: "alice" });

    expect(fake.calls.map((call) => call.input)).toEqual([
      "https://cosheaf.example/api/v1/me",
      "https://cosheaf.example/api/v1/me",
    ]);
  });

  it("keeps RemotePullClient-compatible null whoami for rejected tokens", async () => {
    const fake = fakeFetch(() => jsonResponse({ user: null }));
    const client = new CosheafOriginClient("https://cosheaf.example", "tok", { fetch: fake.fetch });

    await expect(client.whoami()).resolves.toBeNull();
  });

  it("sends bearer auth on requests", async () => {
    const fake = fakeFetch(() => jsonResponse({ user: null }));
    const client = new CosheafOriginClient("https://cosheaf.example", "secret-token", { fetch: fake.fetch });

    await client.me();

    expect(headerValue(fake.calls[0]?.init, "authorization")).toBe("Bearer secret-token");
    expect(headerValue(fake.calls[0]?.init, "content-type")).toBe("application/json");
  });

  it("lists pull requests through the typed Cosheaf pulls endpoint", async () => {
    const pull = {
      number: 2,
      title: "Update notes",
      state: "open" as const,
      merged: false,
      author_username: "alice",
      head_ref: "feature",
      base_ref: "main",
    };
    const fake = fakeFetch(() => jsonResponse({ pulls: [pull] }));
    const client = new CosheafOriginClient("https://cosheaf.example", "tok", { fetch: fake.fetch });

    await expect(client.listPulls("owner", "repo", "all")).resolves.toEqual([pull]);

    expect(fake.calls[0]?.input).toBe("https://cosheaf.example/api/v1/repos/owner/repo/pulls?state=all");
  });

  it("opens pull requests with the expected JSON body", async () => {
    const fake = fakeFetch(() => jsonResponse({ number: 7 }, 201));
    const client = new CosheafOriginClient("https://cosheaf.example", "tok", { fetch: fake.fetch });

    await expect(
      client.openPull("owner", "repo", { head: "feature", base: "main", title: "Proposal", body: "Details" }),
    ).resolves.toEqual({ number: 7 });

    expect(fake.calls[0]?.input).toBe("https://cosheaf.example/api/v1/repos/owner/repo/pulls");
    expect(fake.calls[0]?.init?.method).toBe("POST");
    expect(fake.calls[0]?.init?.body).toBe(JSON.stringify({ head: "feature", base: "main", title: "Proposal", body: "Details" }));
  });

  it("encodes owner and repo path segments", async () => {
    const fake = fakeFetch(() => jsonResponse({ pulls: [] }));
    const client = new CosheafOriginClient("https://cosheaf.example/base/", "tok", { fetch: fake.fetch });

    await client.listPulls("team space", "repo/name", "open");

    expect(fake.calls[0]?.input).toBe("https://cosheaf.example/base/api/v1/repos/team%20space/repo%2Fname/pulls?state=open");
    expect(client.pullUrl("team space", "repo/name", 3)).toBe("https://cosheaf.example/base/team%20space/repo%2Fname/pulls/3");
  });

  it("wraps non-2xx responses in RemoteCosheafError", async () => {
    const fake = fakeFetch(() => new Response("bad token", { status: 401 }));
    const client = new CosheafOriginClient("https://cosheaf.example", "tok", { fetch: fake.fetch });

    await expect(client.me()).rejects.toMatchObject({
      name: "RemoteCosheafError",
      status: 401,
      message: "remote cosheaf 401: bad token",
    });
  });

  it("keeps the old RemoteCosheafClient export as a compatibility constructor", async () => {
    const fake = fakeFetch(() => jsonResponse({ user: { username: "alice" } }));
    const client = new RemoteCosheafClient("https://cosheaf.example", "tok", { fetch: fake.fetch });

    await expect(client.whoami()).resolves.toEqual({ username: "alice" });
    expect(client).toBeInstanceOf(CosheafOriginClient);
  });

  it("exports the existing error type", () => {
    expect(new RemoteCosheafError(503, "remote cosheaf 503")).toMatchObject({
      name: "RemoteCosheafError",
      status: 503,
      message: "remote cosheaf 503",
    });
  });
});
