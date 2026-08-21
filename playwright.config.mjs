import { defineConfig } from "playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error("TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required for browser tests");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: { baseURL, browserName: "chromium", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "xcopy /E /I /Y apps\\web\\.next\\static apps\\web\\.next\\standalone\\apps\\web\\.next\\static >nul && set PORT=3000&& node apps/web/.next/standalone/apps/web/server.js",
    url: `${baseURL}/login`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  reporter: [["list"], ["json", { outputFile: "docs/test/results/playwright-result.json" }]],
});
