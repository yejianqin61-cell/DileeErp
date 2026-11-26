# 任务 7：长答案浏览器用例

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务给本阶段做证**：真浏览器里流式放一份万字答案，量最长任务耗时，并看公式、图、高亮是否出来。
- **开工前提**：任务 3、4、6 已提交。**后续**：批次总结。

## 2. 要知道的

**先读**

- `tests/e2e/business-query-recovery.spec.mjs`：页面 testid 与提问方式。
- `apps/web/lib/business-query-stream.ts`：事件帧格式。
- `docs/task/2026-11-24-agent-p2-plan/phase-5/summary-2026-11-26.md` §3：本工作树怎么起 Web。

**已定**

- 新 spec `tests/e2e/agent-long-answer.spec.mjs`。**不需要 API 与数据库**：用 `page.addInitScript` 包住 `fetch`，
  自己回 `/api/v1/auth/me`、会话、建轮次和事件流。
- 事件流是真的分段推送：每 16 毫秒 20 个字。答案至少 10000 字，含标题、列表、表格、代码块、块级公式、mermaid 图。
- 量法：`PerformanceObserver` 收 `longtask`，只算首个增量到 `completed` 之间的；最大值不超过 100 毫秒。
  同时断言收到过至少 3 次正文变化，防止「整段一次画完」蒙混过关。
- 100 毫秒是本机口径：只有设了 `AGENT_PERF_GATE=1` 才断言它，否则只打印实测值（CI 机器不可比，本批决定）。

**边界与接缝**

- 只加这一个 spec。接缝：真实浏览器。

**运行**

- 构建 Web 后手工起独立产物（`server.js` 在 `.next/standalone` 的嵌套目录里，`.next/static` 要拷过去）。
- 设 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000` 与 `AGENT_PERF_GATE=1`，
  `npx playwright test tests/e2e/agent-long-answer.spec.mjs --repeat-each=3`

**可能卡住**

- 超过 100 毫秒：可以给顶层块按原文片段做记忆化再量一次；仍超就**停下上报实测数值**，不放宽上限、不缩短答案。
- 事件流假实现让页面走不到完成：停下上报卡在哪个请求。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写假接口与分段事件流，让页面走到「已完成」。
3. 加用例 1、2 的度量与断言。
4. 起 Web，连跑三次，记下最大耗时。
5. 提交：`test(agent): 万字答案流式耗时与公式图表高亮的浏览器用例`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 万字答案流式 | 首增量到完成之间没有超过 100 毫秒的长任务；正文变化至少 3 次 | 浏览器 |
| 2 | 同一轮完成后 | 可见 `.katex`、图表 `svg`、`.token`；末段文字完整；没有流式光标 | 浏览器 |

</task-brief>
