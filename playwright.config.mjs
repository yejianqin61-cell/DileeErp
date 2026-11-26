import { defineConfig } from "playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) throw new Error("TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required for browser tests");

// Next.js 的 standalone 产物不会自带 static 与 public 目录，需要拷进去（与 apps/web/Dockerfile 一致）；
// 缺 public 时 sw.js、manifest 和图标都是 404，浏览器用例测不到 Service Worker。
// 原实现硬编码 Windows 的 xcopy，导致同一份配置在 Linux CI 上无法启动 Web —— 这里按平台分支。
const isWindows = process.platform === "win32";
const copyAssets = isWindows
  ? "xcopy /E /I /Y apps\\web\\.next\\static apps\\web\\.next\\standalone\\apps\\web\\.next\\static >nul && xcopy /E /I /Y apps\\web\\public apps\\web\\.next\\standalone\\apps\\web\\public >nul"
  : "mkdir -p apps/web/.next/standalone/apps/web/.next && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/ && cp -r apps/web/public apps/web/.next/standalone/apps/web/";
const setPort = isWindows ? "set PORT=3000&& " : "PORT=3000 ";
const webServerCommand = `${copyAssets} && ${setPort}node apps/web/.next/standalone/apps/web/server.js`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: { baseURL, browserName: "chromium", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: webServerCommand,
    url: `${baseURL}/login`,
    // 复用已在跑的服务：本地 dev-test-up 或 CI 显式启动的 Web 都会被直接使用。
    reuseExistingServer: true,
    timeout: 60_000,
  },
  reporter: [["list"], ["json", { outputFile: "docs/test/results/playwright-result.json" }]],
});
