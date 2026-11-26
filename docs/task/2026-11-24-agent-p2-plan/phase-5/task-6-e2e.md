# 任务 6：浏览器端到端迁移

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**。
- **本任务给本阶段做证**：续接用例在新路径下绿，旧路径回 308，真浏览器里缓存能先出内容。
- **开工前提**：任务 2、5 已提交。**后续**：批次总结。

## 2. 要知道的

**先读**

- `tests/e2e/business-query-recovery.spec.mjs`：现有六条用例与环境变量门槛。
- `playwright.config.mjs`：Web 怎么起、`PLAYWRIGHT_BASE_URL`。
- `docker-compose.yml`：本地库与 API 需要哪些变量。

**已定**

- 现有用例只改两处：`goto("/agent")` 与 `page-agent`。接口路径与其余断言不动，文件名不改。
- 新增两条（下表 2、3）。缓存那条放单独的 `describe`，`test.use({ serviceWorkers: "block" })`，
  用 `page.route` 挂住匹配 `/api/v1/business-query/sessions` 的请求。

**边界与接缝**

- 只动这一个 spec。接缝：真实浏览器。

**运行**

- `npx playwright test tests/e2e/business-query-recovery.spec.mjs --list`（先设 `PLAYWRIGHT_BASE_URL=http://localhost:3000`）
- 有本地全栈时去掉 `--list`；还需 `INITIAL_ADMIN_USERNAME`、`INITIAL_ADMIN_PASSWORD`、`AGENT_FAKE_DELAY_MS` 不小于 500。

**可能卡住**

- 全栈起不来（没有库、没有账号、非读 `.env` 不可）：**停下上报**，说清缺什么。用户同意后可只提交改动，
  总结里写「E2E 未跑」，不得写通过。
- 缓存用例拿不到内容：先查账号是否带 `laoban`/`caiwu`（带了本就不落盘）与 IndexedDB 有无数据，再上报；不放宽断言。

## 3. 步骤

1. 读上面三个文件，用一行复述任务。
2. 改两处路径，加用例 2、3。
3. 跑 `--list`，应列出 8 条。
4. 起本地全栈跑全部；跑不了按「可能卡住」处理。
5. 提交：`test(agent): 续接用例迁到 /agent，加 308 与缓存先出两条`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 现有六条在新路径下 | 全部通过 | 浏览器 |
| 2 | `page.request.get("/business-query", { maxRedirects: 0 })` | 状态 308，`location` 为 `/agent` | HTTP |
| 3 | 管理员提问到「已完成」；挂住会话列表请求；刷新 | `business-query-answer` 可见（此时数据只能来自本地） | 浏览器 |

</task-brief>
