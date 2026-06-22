import { describe, expect, it } from "vitest";
import { AsyncJobLimiter } from "./async-job-limiter.js";

function limiter() {
  let now = 1_000;
  const jobs = new AsyncJobLimiter({
    config: () => ({ concurrency: 1, queueLimit: 1, cooldownMs: 10 }),
    duplicateError: () => new Error("duplicate"),
    queueFullError: () => new Error("queue-full"),
    resetError: () => new Error("reset"),
    now: () => now,
  });
  return {
    jobs,
    advance(ms: number) {
      now += ms;
    },
  };
}

function staticLimiter() {
  return new AsyncJobLimiter({
    config: () => ({ concurrency: 1, queueLimit: 1, cooldownMs: 10 }),
    duplicateError: () => new Error("duplicate"),
    queueFullError: () => new Error("queue-full"),
    now: () => 1_000,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AsyncJobLimiter", () => {
  it("rejects duplicate keys while the first job is active", async () => {
    const jobs = staticLimiter();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = jobs.run("same", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });

    await firstStarted.promise;
    await expect(jobs.run("same", async () => undefined)).rejects.toThrow("duplicate");
    releaseFirst.resolve();
    await first;
  });

  it("rejects jobs when the queue is full", async () => {
    const jobs = staticLimiter();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = jobs.run("a", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const second = jobs.run("b", async () => undefined);

    await expect(jobs.run("c", async () => undefined)).rejects.toThrow("queue-full");
    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  it("reports active and queued metrics", async () => {
    const jobs = staticLimiter();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const first = jobs.run("a", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const second = jobs.run("b", async () => {
      secondStarted.resolve();
    });

    expect(jobs.metrics()).toEqual({ active: 1, queued: 1, concurrency: 1, queueLimit: 1 });
    releaseFirst.resolve();
    await secondStarted.promise;
    await Promise.all([first, second]);
    expect(jobs.metrics()).toEqual({ active: 0, queued: 0, concurrency: 1, queueLimit: 1 });
  });

  it("keeps a completed key in cooldown until the configured time expires", async () => {
    const { jobs, advance } = limiter();

    await jobs.run("same", async () => undefined);
    await expect(jobs.run("same", async () => undefined)).rejects.toThrow("duplicate");
    advance(10);
    await expect(jobs.run("same", async () => "ok")).resolves.toBe("ok");
  });

  it("cleans up active state after a job fails", async () => {
    const { jobs, advance } = limiter();

    await expect(jobs.run("same", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(jobs.metrics()).toEqual({ active: 0, queued: 0, concurrency: 1, queueLimit: 1 });
    await expect(jobs.run("same", async () => undefined)).rejects.toThrow("duplicate");
    advance(10);
    await expect(jobs.run("same", async () => "ok")).resolves.toBe("ok");
  });

  it("rejects queued jobs during reset", async () => {
    const { jobs } = limiter();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = jobs.run("a", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const queued = jobs.run("b", async () => undefined);

    expect(jobs.metrics()).toEqual({ active: 1, queued: 1, concurrency: 1, queueLimit: 1 });
    jobs.reset();
    await expect(queued).rejects.toThrow("reset");
    expect(jobs.metrics()).toEqual({ active: 0, queued: 0, concurrency: 1, queueLimit: 1 });

    releaseFirst.resolve();
    await first;
  });
});
