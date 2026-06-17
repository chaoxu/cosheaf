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
});

describe("api errors", () => {
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
