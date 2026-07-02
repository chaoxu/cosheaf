import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Forgejo } from "./forgejo.js";
import { ForgejoWorkspaceBackend } from "./forgejo-backend.js";
import { fakeForgejo } from "./routes/test-fixtures.js";
import { WorkspaceBackendError } from "./workspace-backend.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function backend(): ForgejoWorkspaceBackend {
  return new ForgejoWorkspaceBackend(new Forgejo({ baseUrl: "http://forgejo.test", token: "t" }));
}

describe("ForgejoWorkspaceBackend error translation", () => {
  it("maps Forgejo stale-sha 422 bodies to WorkspaceBackend stale_sha", async () => {
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.put("/api/v1/repos/owner/w/contents/notes.md", (c) =>
          c.text("sha does not match [given: A, expected: B]", 422),
        );
      }),
    );

    await expect(
      backend().putFile("owner", "w", {
        branch: "user/alice/wip",
        path: "notes.md",
        content: "# Notes\n",
        sha: "A",
        message: "update notes.md",
      }),
    ).rejects.toMatchObject({ status: 422, code: "stale_sha" } satisfies Partial<WorkspaceBackendError>);
  });

  it("keeps unrelated Forgejo 422 bodies as unprocessable", async () => {
    fetchMock.mockImplementation(
      fakeForgejo((forge: Hono) => {
        forge.put("/api/v1/repos/owner/w/contents/notes.md", (c) => c.text("content is invalid", 422));
      }),
    );

    await expect(
      backend().putFile("owner", "w", {
        branch: "user/alice/wip",
        path: "notes.md",
        content: "# Notes\n",
        sha: "A",
        message: "update notes.md",
      }),
    ).rejects.toMatchObject({ status: 422, code: "unprocessable" } satisfies Partial<WorkspaceBackendError>);
  });
});
