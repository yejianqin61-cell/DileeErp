import { defineConfig } from "playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error("TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required for browser tests");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { baseURL, browserName: "chromium", trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [["list"], ["json", { outputFile: "docs/test/results/playwright-result.json" }]],
});
