# 任务 7：浏览器端到端

<task-brief>

## 1. 在哪里

- **阶段 7 会话能像样地用**。
- **本任务给本阶段做证**：真浏览器、真后端里五项体验可用，续接用例没有退步。
- **开工前提**：任务 6 已提交。**后续**：批次总结。

## 2. 要知道的

**先读**

- `tests/e2e/business-query-recovery.spec.mjs`：登录与辅助函数。
- `.github/workflows/test.yml` 的链路门禁：起库、迁移、灌账号、起服务要的变量。
- `docs/task/2026-11-24-agent-p2-plan/phase-5/summary-2026-11-26.md`：本工作树怎么起 Web。

**已定**

- 新 spec `tests/e2e/agent-session.spec.mjs`；辅助函数照抄需要的几个，不改旧 spec。
- 环境用**新起的一次性 PostgreSQL 容器**（名 `dilee-p2-e2e`，只绑 `127.0.0.1:55499`）加假模型；跑完删容器、停服务。
  不碰已有容器。账号密码用工作流文件里的测试值。
- 三个 spec 一起跑：本 spec、续接、长答案。

**边界与接缝**

- 只加这个 spec。接缝：真实浏览器。

**运行**

- `npm run db:test:prepare`、`npx tsx apps/api/prisma/seed.ts`，起 API 与 Web
- `npx playwright test tests/e2e/agent-session.spec.mjs tests/e2e/business-query-recovery.spec.mjs tests/e2e/agent-long-answer.spec.mjs`

**可能卡住**

- 全栈起不来或要读 `.env`：停下上报缺什么。
- 旧用例失败：先单独重跑并查原因，**停下上报**，不改旧断言。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写下表用例。
3. 起一次性库，迁移并灌账号，起服务。
4. 跑三个 spec；深色主题下截一张图，人工看文字是否可读，结果写进总结。
5. 删容器、停服务，提交：`test(agent): 会话体验的浏览器端到端`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 打半句不发，刷新 | 输入框内容还在 | 浏览器 |
| 2 | 问两轮，改第二问发送，切回旧版本，刷新 | 版本号 `1/2`，显示旧问题 | 浏览器 |
| 3 | 改名后刷新开历史；再删除后刷新 | 先见新名；后列表里没有它 | 浏览器 |
| 4 | 选深色与英文后刷新 | 属性为 `dark`，欢迎或阶段文字为英文 | 浏览器 |
| 5 | 另两个 spec | 全部通过 | 浏览器 |

</task-brief>
