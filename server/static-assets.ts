import { type Dirent, readdirSync } from "node:fs";

// Top-level public/ files cosheaf serves directly at "/<name>": island helper
// scripts (cosheaf-*.js), the server-rendered chrome stylesheet (*.css), and
// the favicon. The fonts/ subdirectory is served by the dedicated /fonts/*
// route, so directories are skipped here.
//
// Scanning the directory rather than hand-maintaining an allowlist means a new
// public/cosheaf-*.js island helper is wired up automatically — the prior Set
// silently 404'd any helper a contributor forgot to register.
export function listPublicAssetPaths(publicDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(publicDir, { withFileTypes: true });
  } catch (_error) {
    // No public dir (e.g. an unusual deploy layout) — serve nothing from it.
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (/^cosheaf-[\w.-]+\.js$/.test(entry.name) || entry.name.endsWith(".css") || entry.name === "favicon.svg"),
    )
    .map((entry) => `/${entry.name}`)
    .sort();
}
