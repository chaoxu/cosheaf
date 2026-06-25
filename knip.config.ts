import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: [
    "src/cosheaf/web-editor.tsx",
    "src/cosheaf/web-edit-shell.ts",
    "src/cosheaf/web-comment-editor.tsx",
    "src/cosheaf/web-reader.ts",
  ],
  project: ["src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
  ignoreDependencies: [
    // Loaded via @tailwindcss/vite, not imported directly.
    "tailwindcss",
  ],
  include: ["files", "dependencies", "unlisted"],
};

export default config;
