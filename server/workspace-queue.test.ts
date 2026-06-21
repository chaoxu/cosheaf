import { describe, expect, it } from "vitest";
import { serializeWorkspace } from "./workspace-queue.js";

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("serializeWorkspace", () => {
  it("runs jobs for the same workspace in order", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeWorkspace("owner/repo", async () => {
      events.push("first:start");
      await firstReady;
      events.push("first:end");
      return "first";
    });
    const second = serializeWorkspace("owner/repo", async () => {
      events.push("second:start");
      return "second";
    });

    await nextTick();
    expect(events).toEqual(["first:start"]);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not block unrelated workspaces", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializeWorkspace("owner/a", async () => {
      events.push("a:start");
      await firstReady;
    });
    const second = serializeWorkspace("owner/b", async () => {
      events.push("b:start");
    });

    await second;
    expect(events).toEqual(["a:start", "b:start"]);
    releaseFirst();
    await first;
  });
});
