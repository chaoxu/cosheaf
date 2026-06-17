import { defineConfig } from "@playwright/test";
import { browserWebUrl } from "./scripts/browser-utils.mjs";
import { loadDotenvDev } from "./scripts/lib/env-dev.mjs";

loadDotenvDev();

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /smoke\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: browserWebUrl(),
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
