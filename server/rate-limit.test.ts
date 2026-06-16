import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("allows up to max hits per window, then blocks", () => {
    const rl = new FixedWindowRateLimiter(3, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("a", 100)).toBe(true);
    expect(rl.tryAcquire("a", 200)).toBe(true);
    expect(rl.tryAcquire("a", 300)).toBe(false);
  });

  it("resets the count once the window elapses", () => {
    const rl = new FixedWindowRateLimiter(2, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("a", 1)).toBe(true);
    expect(rl.tryAcquire("a", 2)).toBe(false);
    // At/after resetAt (0 + 1000) a fresh window starts.
    expect(rl.tryAcquire("a", 1000)).toBe(true);
    expect(rl.tryAcquire("a", 1001)).toBe(true);
    expect(rl.tryAcquire("a", 1002)).toBe(false);
  });

  it("tracks keys independently", () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("b", 0)).toBe(true);
    expect(rl.tryAcquire("a", 0)).toBe(false);
    expect(rl.tryAcquire("b", 0)).toBe(false);
  });

  it("reset() clears all windows", () => {
    const rl = new FixedWindowRateLimiter(1, 1000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("a", 0)).toBe(false);
    rl.reset();
    expect(rl.tryAcquire("a", 0)).toBe(true);
  });
});
