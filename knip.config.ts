import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/cosheaf/web-editor.tsx",
    "src/cosheaf/web-edit-shell.ts",
    "src/cosheaf/web-comment-editor.tsx",
    "src/cosheaf/web-reader.ts",
    "server/**/*.test.ts",
    "src/**/*.test.ts",
    "tests/**/*.ts",
    "scripts/**/*.mjs",
    "playwright*.config.ts",
  ],
  project: ["src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
  ignoreDependencies: [
    // Loaded via @tailwindcss/vite, not imported directly.
    "tailwindcss",
    // Provided for @chaoxu/coflat's bundled editor island (rich paste), which
    // externalizes it; cosheaf resolves it at build time but never imports it.
    "turndown",
  ],
  ignoreExportsUsedInFile: true,
  include: ["files", "dependencies", "unlisted", "exports", "types"],
};

export default config;
