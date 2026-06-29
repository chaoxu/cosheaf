import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshTestDb } from "../routes/test-fixtures.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

function gitInit(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
}

describe("WorkspaceRegistry sidecar protection", () => {
  it("gitignores the .cosheaf sidecar so a Cosheaf token in remote.json is never committed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-reg-"));
    gitInit(dir);
    writeFileSync(join(dir, "hello.md"), "# Hello\n");

    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-reg-db-"));
    await reg.addFolder(dir);

    // Opening the folder writes a self-ignoring sidecar .gitignore.
    expect(existsSync(join(dir, ".cosheaf", ".gitignore"))).toBe(true);
    expect(readFileSync(join(dir, ".cosheaf", ".gitignore"), "utf8")).toContain("*");

    // A Tier-2 token lands in the sidecar; a Tier-1 `git add -A` must skip it.
    writeFileSync(join(dir, ".cosheaf", "remote.json"), JSON.stringify({ url: "http://x", token: "cosheaf_secret" }));
    execFileSync("git", ["-C", dir, "add", "-A"]);
    const staged = execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"], { encoding: "utf8" });
    expect(staged).not.toContain(".cosheaf/remote.json");
    expect(staged).toContain("hello.md");
  });

  it("derives a local/<folder> slug for a folder with no git upstream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-reg-noremote-"));
    writeFileSync(join(dir, "a.md"), "# A\n");
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-reg-db2-"));
    const entry = await reg.addFolder(dir);
    expect(entry.identity.owner).toBe("local");
    expect(entry.gitRemote).toBeNull();
    expect(entry.identity.canOpenPull).toBe(false);
  });
});
