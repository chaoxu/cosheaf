import type { KnipConfig } from "knip";

const config: KnipConfig = {
  entry: ["src/cosheaf/main.tsx", "server/index.ts", "server/cli.ts"],
  project: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
  ignoreDependencies: [
    // Loaded via @tailwindcss/vite, not imported directly.
    "tailwindcss",
  ],
  include: ["files", "dependencies", "unlisted"],
};

export default config;
