// Minimal fixed-window in-memory rate limiter. Keyed by an arbitrary string
// (e.g. a client IP). Not distributed — like the auth flow's loginQueues it is
// per-process, which is enough to blunt trivial abuse of the anonymous
// /register endpoint. `now` is injectable so the window logic is unit-testable
// without touching the clock.
export class FixedWindowRateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  // Returns true if this hit is within the per-key budget for the current
  // window (and records it), false once the budget is exhausted. A new or
  // expired window resets the count, so the map stays bounded by the number of
  // distinct keys seen within one window.
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (window.count >= this.max) return false;
    window.count += 1;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }
}
