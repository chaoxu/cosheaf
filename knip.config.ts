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
  ],
  ignoreExportsUsedInFile: true,
  include: ["files", "dependencies", "unlisted", "exports", "types"],
};

export default config;
