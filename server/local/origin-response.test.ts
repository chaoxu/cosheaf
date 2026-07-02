import { describe, expect, it } from "vitest";
import { parseOriginResponse, RemoteCosheafError } from "./origin-response.js";

describe("parseOriginResponse", () => {
  it("parses JSON bodies", async () => {
    await expect(parseOriginResponse(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("returns undefined for empty success bodies", async () => {
    await expect(parseOriginResponse(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  });

  it("wraps non-2xx responses in RemoteCosheafError", async () => {
    await expect(parseOriginResponse(new Response("bad token", { status: 401 }))).rejects.toMatchObject({
      name: "RemoteCosheafError",
      status: 401,
      message: "remote cosheaf 401: bad token",
    });
  });

  it("exports the existing error type", () => {
    expect(new RemoteCosheafError(503, "remote cosheaf 503")).toMatchObject({
      name: "RemoteCosheafError",
      status: 503,
      message: "remote cosheaf 503",
    });
  });
});
