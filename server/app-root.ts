import { existsSync } from "node:fs";
import path from "node:path";

// The directory that holds the server's runtime assets: the built island
// `dist/`, server-rendered `public/`, and (when packaged) a vendored coflat
// `dist/`.
//
// - Repo checkout (dev: `pnpm dev:all`, `pnpm workbench` from the repo): pnpm
//   runs from the repo root, so `process.cwd()` already points at the tree that
//   holds `dist/`/`public/`. Nothing to configure.
// - Packaged Workbench bundle: the `cosheaf-workbench` shim sets
//   `COSHEAF_APP_ROOT` to the unpacked bundle directory so the same server can
//   serve its assets from outside any repo (the cwd is then the user's content
//   folder, not the bundle).
export function resolveAppRoot(): string {
  const explicit = process.env.COSHEAF_APP_ROOT?.trim();
  return explicit ? path.resolve(explicit) : process.cwd();
}

// Where the built coflat reader/editor dist lives. A packaged bundle vendors it
// under `<appRoot>/vendor/coflat` (no node_modules to resolve from); a repo
// checkout resolves `@chaoxu/coflat/style.css` from node_modules. The sentinel is
// `editor.css` — the file that `@chaoxu/coflat/style.css` actually maps to, and
// a sibling of every other asset the `/vendor/coflat/*` route serves.
export function resolveCoflatDistDir(appRoot: string, resolveFromNodeModules: () => string): string {
  const vendored = path.join(appRoot, "vendor", "coflat");
  if (existsSync(path.join(vendored, "editor.css"))) return vendored;
  return path.dirname(resolveFromNodeModules());
}
