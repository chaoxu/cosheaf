import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { withWorkspaceSidecarLock } from "./workspace-lock.js";

function freshDbPair(): [Database.Database, Database.Database] {
  const dir = mkdtempSync(path.join(tmpdir(), "cosheaf-lock-"));
  const file = path.join(dir, "test.sqlite");
  const first = new Database(file);
  first.pragma("journal_mode = WAL");
  first.pragma("foreign_keys = ON");
  first.exec(readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const second = new Database(file);
  second.pragma("journal_mode = WAL");
  second.pragma("foreign_keys = ON");
  return [first, second];
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withWorkspaceSidecarLock", () => {
  it("serializes the same workspace across database connections", async () => {
    const [firstDb, secondDb] = freshDbPair();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorkspaceSidecarLock(firstDb, "owner/repo", async () => {
      events.push("first:start");
      await firstReady;
      events.push("first:end");
      return "first";
    });
    const second = withWorkspaceSidecarLock(secondDb, "owner/repo", async () => {
      events.push("second:start");
      return "second";
    });

    await nextTick();
    expect(events).toEqual(["first:start"]);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows nested acquisition in the same async call chain", async () => {
    const [db] = freshDbPair();
    const events: string[] = [];

    await withWorkspaceSidecarLock(db, "owner/repo", async () => {
      events.push("outer");
      await withWorkspaceSidecarLock(db, "owner/repo", async () => {
        events.push("inner");
      });
    });

    expect(events).toEqual(["outer", "inner"]);
  });
});
