import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
  ignoreDependencies: [
    // Loaded via @tailwindcss/vite, not imported directly.
    "tailwindcss",
  ],
  include: ["files", "dependencies", "unlisted"],
};

export default config;
