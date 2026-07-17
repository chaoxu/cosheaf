import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(entry.identity.originId).toMatch(/^local-[0-9a-f]{16}$/);
  });

  it("ignores an invalid remote sidecar instead of enabling open PR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-reg-badremote-"));
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(join(dir, ".cosheaf", "remote.json"), JSON.stringify({ url: "ftp://cosheaf.example", token: "secret" }));
    writeFileSync(join(dir, "a.md"), "# A\n");

    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-reg-db3-"));
    const entry = await reg.addFolder(dir);
    expect(entry.remote).toBeNull();
    expect(entry.identity.canOpenPull).toBe(false);
  });

  it("drops stale markdown and citation rows when a folder is re-indexed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-reg-index-"));
    writeFileSync(join(dir, "gone.md"), "# Gone\n");
    writeFileSync(join(dir, "refs.bib"), "@article{Gone2026, title={Gone}}\n");
    const db = freshTestDb("cosheaf-reg-index-db-");
    const reg = new WorkspaceRegistry(db);
    const entry = await reg.addFolder(dir);
    expect(db.prepare("SELECT path FROM notes_fts WHERE workspace_slug = ?").all(entry.slug)).toEqual([
      { path: "gone.md" },
    ]);
    expect(db.prepare("SELECT target_id, source_path FROM citation_targets WHERE workspace_slug = ?").all(entry.slug)).toEqual([
      { target_id: "Gone2026", source_path: "refs.bib" },
    ]);

    rmSync(join(dir, "gone.md"));
    rmSync(join(dir, "refs.bib"));
    await reg.index(entry);

    expect(db.prepare("SELECT count(*) AS c FROM doc_map WHERE workspace_slug = ?").get(entry.slug)).toEqual({ c: 0 });
    expect(db.prepare("SELECT count(*) AS c FROM citation_targets WHERE workspace_slug = ?").get(entry.slug)).toEqual({ c: 0 });
  });
});

describe("WorkspaceRegistry profile", () => {
  it("persists the git authorship profile and reloads it from the config file", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-prof-")), "workspaces.json");
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-prof-db-"), { configPath: cfg });
    await reg.load();
    expect(reg.getProfile()).toBeNull();
    reg.setProfile({ name: "Ada Lovelace", email: "ada@x.test" });
    expect(reg.getProfile()).toEqual({ name: "Ada Lovelace", email: "ada@x.test" });

    // A fresh registry over the same config file reloads the profile.
    const reg2 = new WorkspaceRegistry(freshTestDb("cosheaf-prof-db2-"), { configPath: cfg });
    await reg2.load();
    expect(reg2.getProfile()).toEqual({ name: "Ada Lovelace", email: "ada@x.test" });
  });

  it("ignores a blank profile", () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-prof2-")), "workspaces.json");
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-prof-db3-"), { configPath: cfg });
    reg.setProfile({ name: "  ", email: "" });
    expect(reg.getProfile()).toBeNull();
  });
});

describe("WorkspaceRegistry saved remotes", () => {
  it("persists saved remote server API keys and reloads them from the config file", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-remotes-")), "workspaces.json");
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-remotes-db-"), { configPath: cfg });
    await reg.load();
    const saved = reg.saveRemote({
      url: "https://core.example/",
      token: "cosheaf_token",
      username: "alice",
      label: "Alice",
    });
    expect(saved).toMatchObject({
      url: "https://core.example",
      token: "cosheaf_token",
      username: "alice",
      label: "Alice",
    });

    const raw = JSON.parse(readFileSync(cfg, "utf8")) as { remotes?: Array<Record<string, unknown>> };
    expect(raw.remotes).toHaveLength(1);
    expect(raw.remotes?.[0]).not.toHaveProperty("source");
    expect(raw.remotes?.[0]).not.toHaveProperty("workspaceSlug");
    expect(statSync(cfg).mode & 0o777).toBe(0o600);

    const reg2 = new WorkspaceRegistry(freshTestDb("cosheaf-remotes-db2-"), { configPath: cfg });
    await reg2.load();
    expect(reg2.getSavedRemotes()).toHaveLength(1);
    expect(reg2.getSavedRemote(saved?.id ?? "")).toMatchObject({
      url: "https://core.example",
      username: "alice",
      label: "Alice",
    });
  });

  it("replaces the same server/token entry and can remove it", () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-remotes2-")), "workspaces.json");
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-remotes-db3-"), { configPath: cfg });
    const first = reg.saveRemote({ url: "https://core.example", token: "tok", username: "alice", label: "Old" });
    const second = reg.saveRemote({ url: "https://core.example/", token: "tok", username: "alice", label: "New" });
    expect(second?.id).toBe(first?.id);
    expect(reg.getSavedRemotes()).toHaveLength(1);
    expect(reg.getSavedRemotes()[0]?.label).toBe("New");

    expect(reg.removeSavedRemote(second?.id ?? "")).toBe(true);
    expect(reg.getSavedRemotes()).toEqual([]);
  });

  it("ignores malformed saved remotes in the config file", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-remotes3-")), "workspaces.json");
    writeFileSync(cfg, JSON.stringify({
      remotes: [
        { url: "ftp://core.example", token: "tok", username: "alice" },
        { url: "https://core.example", token: "", username: "alice" },
        { url: "https://ok.example", token: "tok", username: "bob" },
      ],
    }));
    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-remotes-db4-"), { configPath: cfg });
    await reg.load();
    expect(reg.getSavedRemotes()).toHaveLength(1);
    expect(reg.getSavedRemotes()[0]?.url).toBe("https://ok.example");
  });

  it("lists already-connected workspace remotes without copying them into central saved config", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cosheaf-reg-remotes4-")), "workspaces.json");
    const dir = mkdtempSync(join(tmpdir(), "cosheaf-reg-connected-"));
    mkdirSync(join(dir, ".cosheaf"), { recursive: true });
    writeFileSync(join(dir, ".cosheaf", "remote.json"), JSON.stringify({ url: "https://core.example", token: "existing_token" }));
    writeFileSync(join(dir, "a.md"), "# A\n");

    const reg = new WorkspaceRegistry(freshTestDb("cosheaf-remotes-db5-"), { configPath: cfg });
    const entry = await reg.addFolder(dir);
    const remote = reg.getSavedRemotes()[0];

    expect(remote).toMatchObject({
      url: "https://core.example",
      token: "existing_token",
      username: null,
      label: `${entry.slug} current key`,
      source: "workspace",
      workspaceSlug: entry.slug,
    });
    expect(reg.getSavedRemote(remote?.id ?? "")).toMatchObject({ token: "existing_token" });

    const raw = JSON.parse(readFileSync(cfg, "utf8")) as { remotes?: unknown[] };
    expect(raw.remotes).toBeUndefined();
  });
});
