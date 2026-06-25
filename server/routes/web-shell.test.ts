import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globalSidebar, sidebarIdentity } from "./web-shell.js";

// Narrow source cross-check (allowed per AGENTS.md: regex over source text in a
// test). A page island only mounts in production if THREE things agree:
//   1. web-shell.ts references its entry id via viteEntryAssets("src/cosheaf/…")
//   2. vite.config.ts lists that id in rollupOptions.input
//   3. the built manifest marks it isEntry:true
// Drift between (1) and (2) yields a silent emptyHtml island in prod with no
// 4xx to catch it — exactly the failure this test exists to make loud.

const repoRoot = path.join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

function webShellEntryIds(): string[] {
  const src = read("server/routes/web-shell.ts");
  return [...src.matchAll(/viteEntryAssets\("(src\/cosheaf\/[^"]+)"\)/g)].map((m) => m[1]).sort();
}

function viteInputEntryIds(): string[] {
  const src = read("vite.config.ts");
  const inputBlock = src.match(/input:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  return [...inputBlock.matchAll(/"(src\/cosheaf\/[^"]+)"/g)].map((m) => m[1]).sort();
}

describe("vite island wiring stays in lockstep", () => {
  it("finds the known island entry ids in web-shell.ts", () => {
    // Guards the regex itself against silently matching nothing.
    expect(webShellEntryIds()).toEqual([
      "src/cosheaf/web-comment-editor.tsx",
      "src/cosheaf/web-edit-shell.ts",
      "src/cosheaf/web-editor.tsx",
      "src/cosheaf/web-reader.ts",
    ]);
  });

  it("every web-shell entry id is declared as a vite rollup input", () => {
    expect(webShellEntryIds()).toEqual(viteInputEntryIds());
  });

  it("the built manifest, when present, marks each entry id isEntry:true", () => {
    const manifestPath = path.join(repoRoot, "dist/.vite/manifest.json");
    if (!existsSync(manifestPath)) return; // no build yet — the source cross-check above is the guard
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, { isEntry?: boolean }>;
    for (const id of webShellEntryIds()) {
      expect(manifest[id]?.isEntry, `manifest must mark ${id} as an entry`).toBe(true);
    }
  });
});

describe("shell preference wiring", () => {
  it("applies file labels from an explicit preference without read/build mode", () => {
    const shell = read("server/routes/web-shell.ts");
    const css = read("public/cosheaf-web.css");
    const prefs = read("public/cosheaf-preferences.js");

    expect(shell).toContain("cosheaf:file-labels");
    expect(shell).toContain("data-cosheaf-file-labels");
    expect(prefs).toContain("cosheaf:file-open-mode");
    expect(prefs).toContain("data-file-open-link");
    expect(shell).not.toContain("data-cosheaf-mode");
    expect(shell).not.toContain("cosheaf-mode.js");
    expect(prefs).not.toContain("cosheaf:landing-mode");
    expect(css).toContain('html[data-cosheaf-file-labels="title"] .ftree-name{display:none}');
    expect(css).toContain('html[data-cosheaf-file-labels="title"] .ftree-title{display:inline}');
    expect(css).not.toContain("data-cosheaf-mode");
  });
});

describe("sidebar identity chrome", () => {
  it("exposes help in the global sidebar", () => {
    const body = String(globalSidebar("help", "alice", null));
    expect(body).toContain('href="/help"');
    expect(body).toContain('class="help-circle active"');
    expect(body).not.toContain(">Help</a>");
  });

  it("links identity to the user profile and exposes notification/settings icons", () => {
    const body = String(sidebarIdentity("alice", false, null));
    expect(body).toContain('class="sidebar-identity-link" href="/users/alice"');
    expect(body).toContain('class="notif-bell" href="/account/notifications"');
    expect(body).toContain('class="help-circle" href="/help"');
    expect(body).toContain('class="settings-gear" href="/account/settings"');
  });

  it("marks the settings gear active on account pages without changing the bell", () => {
    const body = String(sidebarIdentity("alice", false, null, undefined, true));
    expect(body).toContain('class="settings-gear active"');
    expect(body).toContain('class="notif-bell"');
  });
});
