import { defineConfig } from "@playwright/test";
import { defaultWebUrl, loadDotenvDev } from "./scripts/lib/env-dev.mjs";

loadDotenvDev();

const webBase = defaultWebUrl();
const storageState = process.env.COSHEAF_E2E_STORAGE_STATE ?? ".playwright/cosheaf-chao-state.json";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false, // state-transition specs publish PRs serially
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: webBase,
    storageState,
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Assumes `pnpm dev:all` is already running.
});
