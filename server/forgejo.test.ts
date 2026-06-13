import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Forgejo, ForgejoError } from "./forgejo.js";
import type { ForgejoRepo } from "./forgejo-types.js";
import { fakeForgejo } from "./routes/test-fixtures.js";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function client(): Forgejo {
  return new Forgejo({ baseUrl: "http://forgejo.test", token: "t" });
}

function repo(name: string, page: number): ForgejoRepo {
  return {
    id: page * 100 + Number(name.replace(/\D/g, "")),
    name,
    full_name: `owner/${name}`,
    default_branch: "main",
    owner: { id: 1, login: "owner" },
    topics: ["cosheaf-format-coflat"],
    permissions: { admin: true, push: true, pull: true },
  };
}

describe("editRepo", () => {
  it("PATCHes /repos/{owner}/{repo} forwarding only the sent fields", async () => {
    let method = "";
    let body: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.patch("/api/v1/repos/owner/repo", async (c) => {
          method = c.req.method;
          body = await c.req.json();
          return c.json({ id: 1, name: "repo", full_name: "owner/repo", default_branch: "main", owner: { id: 1, login: "owner" } });
        });
      }),
    );
    await client().editRepo("owner", "repo", { description: "new desc", private: false });
    expect(method).toBe("PATCH");
    // JSON.stringify drops undefined keys, so a partial patch sends only what was set.
    expect(body).toEqual({ description: "new desc", private: false });
  });

  it("omits an unset field from the request body", async () => {
    let body: unknown = null;
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.patch("/api/v1/repos/owner/repo", async (c) => {
          body = await c.req.json();
          return c.json({ id: 1, name: "repo", full_name: "owner/repo", default_branch: "main", owner: { id: 1, login: "owner" } });
        });
      }),
    );
    await client().editRepo("owner", "repo", { description: "only desc" });
    expect(body).toEqual({ description: "only desc" });
  });
});

describe("searchAllAccessibleRepos", () => {
  it("page-walks until a short batch and concatenates, preserving topics+permissions", async () => {
    const pages: Record<string, ForgejoRepo[]> = {
      "1": Array.from({ length: 50 }, (_, i) => repo(`r${i}`, 1)),
      "2": [repo("last", 2)],
    };
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.get("/api/v1/repos/search", (c) => c.json({ data: pages[c.req.query("page") ?? "1"] ?? [] }));
      }),
    );
    const repos = await client().searchAllAccessibleRepos();
    expect(repos).toHaveLength(51);
    expect(repos[50].full_name).toBe("owner/last");
    expect(repos[0].topics).toEqual(["cosheaf-format-coflat"]);
    expect(repos[0].permissions).toEqual({ admin: true, push: true, pull: true });
  });

  it("returns [] when the search has no data", async () => {
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.get("/api/v1/repos/search", (c) => c.json({ data: [] }));
      }),
    );
    expect(await client().searchAllAccessibleRepos()).toEqual([]);
  });

  it("tolerates a missing data field", async () => {
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.get("/api/v1/repos/search", (c) => c.json({}));
      }),
    );
    expect(await client().searchAllAccessibleRepos()).toEqual([]);
  });
});

describe("removeCollaborator", () => {
  it("DELETEs the collaborator and resolves on 204", async () => {
    let seen = "";
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.delete("/api/v1/repos/owner/repo/collaborators/alice", (c) => {
          seen = c.req.method;
          return c.body(null, 204);
        });
      }),
    );
    await expect(client().removeCollaborator("owner", "repo", "alice")).resolves.toBeUndefined();
    expect(seen).toBe("DELETE");
  });

  it("throws a ForgejoError on a 404", async () => {
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.delete("/api/v1/repos/owner/repo/collaborators/ghost", (c) => c.text("not found", 404));
      }),
    );
    await expect(client().removeCollaborator("owner", "repo", "ghost")).rejects.toBeInstanceOf(ForgejoError);
  });
});
