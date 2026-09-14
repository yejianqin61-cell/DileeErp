/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 前端组件/交互测试专用配置。
//
// 为什么与 lib 的测试分开：
//   apps/web/lib/**/*.test.mjs 使用 Node 内置 node:test（原生类型擦除直跑 .ts，0.76s/108 用例），
//   已稳定且不依赖 jsdom。本配置只负责需要"真实渲染 + 真实事件"的组件测试，
//   两者互不干扰：include 限定在 test/**，且显式 exclude lib/**。
//
// 为什么用 .mts 而不是 .ts：
//   apps/web/package.json 没有 "type": "module"，Vite 会把 .ts 配置文件按 CommonJS 加载，
//   与文件内的 ESM 语法冲突（Vite 已就此发出未来兼容性警告）。改用 .mts 即可显式声明 ESM，
//   无需为测试给 apps/web/package.json 加 "type": "module"（那会影响 Next.js 与既有 lib 测试）。
//
// 详见 docs/test/01-test-master-plan.md §2.2 S1。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // globals 保持关闭：测试显式 import { describe, it, expect }，
    // 避免为 vitest/globals 改动 apps/web/tsconfig.json 而影响 next build 的类型检查。
    globals: false,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "lib/**"],
    // 并发上限：默认按 CPU 数开 worker（本机 16 核），22 个 jsdom + Radix 组件测试文件跑满时
    // 会 `FATAL ERROR: Zone Allocation failed`（exit code 134）—— 已实测复现。
    // 上限 4 实测稳定且最快（27s，全绿）；2 亦可用（52s）。CI 的 2 核机器本就不会超。
    maxWorkers: 4,
    restoreMocks: true,
    clearMocks: true,
    // 组件测试涉及真实计时器与异步状态更新，给出明确上限便于发现悬挂的 loading 态。
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "../../docs/test/results/web-coverage",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts"],
      exclude: ["**/*.test.*", "**/*.d.ts", "**/demo-data.ts"],
    },
  },
});
