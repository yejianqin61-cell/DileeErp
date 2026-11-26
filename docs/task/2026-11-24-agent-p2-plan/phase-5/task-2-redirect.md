# 任务 2：旧路径 308 重定向

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**。
- **本任务收尾 R-8**：旧链接永久落到新页面。
- **开工前提**：任务 1 已提交。**后续**：任务 6。

## 2. 要知道的

**先读**

- `apps/web/next.config.ts`：现有 `rewrites` 与 `headers` 的写法。
- 设计 §6.2：为什么是 308 不是 301。

**已定**

- 一条规则：`{ source: "/business-query/:path*", destination: "/agent", permanent: true }`。
- 旧子路径不保留尾段，一律到 `/agent`（本批决定，新页面没有子路由）。
- 直接切，不做灰度，不保留旧页面。

**边界与接缝**

- 只动 `next.config.ts` 和新测试 `apps/web/lib/agent-redirect.test.mjs`。接缝：导出配置的 `redirects()`。

**运行**

- `node --test apps/web/lib/agent-redirect.test.mjs`
- `npm run test:unit --workspace=@dilee/web`、`npm run typecheck`、`npm run build --workspace=@dilee/web`

**可能卡住**

- node 直接 import `next.config.ts` 会打一条模块类型警告，属正常；直接报错则停下上报。
- `next build` 因内存失败：记下原样错误并上报，不改构建配置。

## 3. 步骤

1. 读上面两处，用一行复述任务。
2. 写用例 1、2，跑出红。
3. 在配置里加 `async redirects()`，跑绿。
4. 跑全套 web 单测、类型检查与构建。
5. 提交：`feat(agent): /business-query 永久重定向到 /agent`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `await config.redirects()` | 深度相等于只含上面那一条规则的数组 | 配置导出 |
| 2 | 同一结果里每条 `source` | 都不以 `/api` 开头（接口代理不受影响） | 配置导出 |

</task-brief>
