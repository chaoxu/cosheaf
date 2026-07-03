import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, putFileBody } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putFileBody", () => {
  it("omits expected_sha when the CAS base is unknown", () => {
    expect(putFileBody("# Notes\n")).toEqual({ content: "# Notes\n" });
  });

  it("sends null when the caller knows the file was absent", () => {
    expect(putFileBody("# Notes\n", undefined, null)).toEqual({
      content: "# Notes\n",
      expected_sha: null,
    });
  });

  it("sends previous_path and a blob sha when both are known", () => {
    expect(putFileBody("# Notes\n", "old.md", "blob-sha")).toEqual({
      content: "# Notes\n",
      previous_path: "old.md",
      expected_sha: "blob-sha",
    });
  });

  it("sends the fallback source sha when provided", () => {
    expect(putFileBody("# Notes\n", undefined, null, "main-sha")).toEqual({
      content: "# Notes\n",
      expected_sha: null,
      expected_source_sha: "main-sha",
    });
  });

  it("sends the edit-branch reset flag only when requested", () => {
    expect(putFileBody("# Notes\n", undefined, null, "main-sha", true)).toEqual({
      content: "# Notes\n",
      expected_sha: null,
      expected_source_sha: "main-sha",
      reset_edit_branch: true,
    });
  });
});

describe("api errors", () => {
  it("reads a file through the typed file route", async () => {
    const fetchMock = vi.fn(async () => Response.json({ content: "# Notes\n", sha: "sha" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getFile("owner", "repo", "notes.md", "main")).resolves.toEqual({
      content: "# Notes\n",
      sha: "sha",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/repos/owner/repo/file?path=notes.md&branch=main", expect.any(Object));
  });

  it("preserves typed error code and details from JSON API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json(
        {
          error: "branch head moved; reload and retry",
          code: "conflict",
          details: { branch_moved: true, current_sha: "new-sha" },
        },
        { status: 409 },
      ),
    ));

    await expect(api.putFile("owner", "repo", "notes.md", "# Notes\n", "user/alice/wip"))
      .rejects.toMatchObject({
        status: 409,
        message: "branch head moved; reload and retry",
        code: "conflict",
        details: { branch_moved: true, current_sha: "new-sha" },
      });
  });

  it("falls back to the HTTP status message for non-JSON API failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));

    await expect(api.putFile("owner", "repo", "notes.md", "# Notes\n", "user/alice/wip"))
      .rejects.toEqual(new ApiError(502, "HTTP 502"));
  });

  it("preserves typed upload error code and details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json(
        {
          error: "asset exceeds 10 MB",
          code: "validation",
          details: { max_bytes: 10 },
        },
        { status: 400 },
      ),
    ));

    await expect(api.uploadAsset("owner", "repo", "user/alice/wip", new File(["x"], "x.png")))
      .rejects.toMatchObject({
        status: 400,
        message: "asset exceeds 10 MB",
        code: "validation",
        details: { max_bytes: 10 },
      });
  });
});

describe("local suggesting API", () => {
  it("sends concrete current SHA for suggesting revert CAS", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ path: "notes.md", content: "", base_text: "", head_sha: "head", current_sha: sha, hunks: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.revertSuggestingHunk("owner", "repo", "notes.md", {
      id: "1:1:1:1",
      kind: "change",
      old_start: 1,
      old_lines: 1,
      new_start: 1,
      new_lines: 1,
    }, { headSha: "head", currentSha: sha });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      path: "notes.md",
      hunk: {
        id: "1:1:1:1",
        kind: "change",
        old_start: 1,
        old_lines: 1,
        new_start: 1,
        new_lines: 1,
      },
      expected_head_sha: "head",
      expected_sha: sha,
    });
  });

  it("sends null current SHA for a known-absent suggesting file", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ path: "notes.md", commit_sha: null, base_text: "", head_sha: "head", current_sha: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.checkpointSuggestingFile("owner", "repo", "notes.md", {
      headSha: "head",
      currentSha: null,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      path: "notes.md",
      expected_head_sha: "head",
      expected_sha: null,
    });
  });

  it("sends concrete current SHA for suggesting checkpoint CAS", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ path: "notes.md", commit_sha: "commit", base_text: "", head_sha: "head", current_sha: sha })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.checkpointSuggestingFile("owner", "repo", "notes.md", {
      headSha: "head",
      currentSha: sha,
    }, "save hunk");

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      path: "notes.md",
      message: "save hunk",
      expected_head_sha: "head",
      expected_sha: sha,
    });
  });
});

describe("local annotation API", () => {
  it("uses typed local annotation routes", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/local-annotations?path=notes.md&status=open")) {
        return Response.json({ annotations: [] });
      }
      if (url.endsWith("/local-annotations/unresolved?path=notes.md")) {
        return Response.json({ annotations: [] });
      }
      if (url.endsWith("/local-annotations") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          path: "notes.md",
          kind: "task",
          body: "tighten intro",
        });
        return Response.json({ annotation: { id: "la_abc", messages: [] } });
      }
      if (url.endsWith("/local-annotations/la_abc") && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ status: "resolved" });
        return Response.json({ annotation: { id: "la_abc", messages: [] } });
      }
      if (url.endsWith("/local-annotations/la_abc/messages") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ body: "done" });
        return Response.json({ annotation: { id: "la_abc", messages: [] } });
      }
      if (url.endsWith("/local-annotations/la_abc") && init?.method === "DELETE") {
        return Response.json({ ok: true });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.listLocalAnnotations("owner", "repo", { path: "notes.md", status: "open" });
    await api.listUnresolvedLocalAnnotations("owner", "repo", { path: "notes.md" });
    await api.createLocalAnnotation("owner", "repo", { path: "notes.md", kind: "task", body: "tighten intro" });
    await api.updateLocalAnnotation("owner", "repo", "la_abc", { status: "resolved" });
    await api.addLocalAnnotationMessage("owner", "repo", "la_abc", { body: "done" });
    await api.deleteLocalAnnotation("owner", "repo", "la_abc");

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
