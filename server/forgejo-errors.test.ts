import { describe, expect, it } from "vitest";
import { ForgejoError } from "./forgejo.js";
import { is404, onForgejo404 } from "./forgejo-errors.js";

const err = (status: number) => new ForgejoError(status, "", "GET", "/x");

describe("is404", () => {
  it("is true only for a ForgejoError with status 404", () => {
    expect(is404(err(404))).toBe(true);
    expect(is404(err(403))).toBe(false);
    expect(is404(err(500))).toBe(false);
  });

  it("is false for non-ForgejoError values", () => {
    expect(is404(new Error("boom"))).toBe(false);
    expect(is404(null)).toBe(false);
    expect(is404(undefined)).toBe(false);
    expect(is404("404")).toBe(false);
  });
});

describe("onForgejo404", () => {
  it("returns the fallback when the promise rejects with a Forgejo 404", async () => {
    const result = await Promise.reject(err(404)).catch(onForgejo404(null));
    expect(result).toBe(null);
  });

  it("passes through different fallback types", async () => {
    expect(await Promise.reject(err(404)).catch(onForgejo404(""))).toBe("");
    expect(await Promise.reject(err(404)).catch(onForgejo404([]))).toEqual([]);
  });

  it("rethrows a non-404 ForgejoError", async () => {
    const forbidden = err(403);
    await expect(Promise.reject(forbidden).catch(onForgejo404(null))).rejects.toBe(forbidden);
  });

  it("rethrows a plain Error", async () => {
    const boom = new Error("boom");
    await expect(Promise.reject(boom).catch(onForgejo404(null))).rejects.toBe(boom);
  });
});
