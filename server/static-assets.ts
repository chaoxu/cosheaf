import { type Dirent, readdirSync } from "node:fs";

function isServableAsset(entry: Dirent): boolean {
  // Top-level asset files cosheaf serves directly at "/<name>": island helper
  // scripts (cosheaf-*.js), the server-rendered chrome stylesheet (*.css), and
  // the favicon. The fonts/ subdirectory is served by the dedicated /fonts/*
  // route, so directories are skipped.
  return (
    entry.isFile() &&
    (/^cosheaf-[\w.-]+\.js$/.test(entry.name) || entry.name.endsWith(".css") || entry.name === "favicon.svg")
  );
}

// Lists the top-level asset paths to serve directly, scanning each given root
// and unioning the result. Scan order is location-agnostic on purpose: in dev
// the files live in public/, but the production image ships only dist/ (Vite
// copies public/ → dist/ at build and the Dockerfile copies dist/, not public/).
// Passing both roots keeps a new cosheaf-*.js helper wired up automatically in
// either layout — the prior hand-kept Set drifted, and a public-only scan 404'd
// every asset in prod.
export function listPublicAssetPaths(...assetDirs: string[]): string[] {
  const paths = new Set<string>();
  for (const dir of assetDirs) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      // A missing root (e.g. dist/ before a build, or public/ in the image) is
      // not an error — the other root supplies the assets.
      continue;
    }
    for (const entry of entries) {
      if (isServableAsset(entry)) paths.add(`/${entry.name}`);
    }
  }
  return [...paths].sort();
}
