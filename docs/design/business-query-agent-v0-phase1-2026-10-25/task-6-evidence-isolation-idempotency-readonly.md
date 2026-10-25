# T-6 证据收口：隔离、幂等与只读

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路的验收证据。
- 本任务落 R-1 与 R-3 的可运行证明：只读拒写、跨用户隔离、幂等与约束的测试收口。
- 前置：T-1 至 T-5 全部完成。本任务不产出产品代码，只产出测试与证据。

## 2. 开发者须知

**先读**

- `apps/api/test/integration/postgres-connectivity.test.cjs` — `TEST_DATABASE_URL` 门禁与连接方式。
- `tests/helpers/test-context.cjs` 与 `scripts/prepare-test-database.mjs` — 测试库准备与 `TEST_BLOCKED` 惯例。
- `apps/api/test/http/sales-orders-contract.test.cjs` 的文件头 — 契约测试的环境门禁、只读探测与断言工具。
- `tests/helpers/api-client.cjs` — 登录、信封断言、x-request-id 的现成函数。
- `apps/api/test/helpers/migration-guards.cjs` — 无库环境下静态推演唯一约束。

**定案（不得重开）**

- 本机无 PostgreSQL 是仓库已知事实：迁移与约束的**静态守卫**必须全绿；集成与 HTTP 测试写成「有环境就能跑」的形态，本地跑不了要如实报告，不算失败。
- 集成测试自建只读角色（`CREATE ROLE ... GRANT SELECT`）证明业务写入被数据库拒绝，测完清理。
- HTTP 契约测试只做只读探测与鉴权层断言，不写业务数据（与现有契约测试同一纪律）。
- 跨用户证据：用户 B 对用户 A 的会话与 run 读、续接、取消全部 403/404。

**边界**

- 新文件：`apps/api/test/integration/business-query-agent.test.cjs`、`apps/api/test/http/business-query-contract.test.cjs`、`apps/api/test/unit/agent-run-constraints.test.cjs`。
- 不改产品代码；若测试暴露产品缺陷，回对应任务修复后另起 `fix(...)` 提交。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-run-constraints.test.cjs`（本机可跑）
- `npm run test:integration -- --test-name-pattern business-query`（需 `TEST_DATABASE_URL`）
- `npm run test:api -- apps/api/test/http/business-query-contract.test.cjs`（需 `API_BASE_URL`）

**未知**

- 集成测试建角色需要测试库账号有 CREATE ROLE 权限；若没有，把该用例标记 `t.skip` 并在报告里说明，不硬造。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写静态守卫单测：部分唯一索引与唯一约束经 `liveUniqueGuards` 推演齐全（红→绿）。
3. 写集成测试：迁移部署、只读角色拒写、并发两问题只有一个活动 run、同键幂等、事件 seq 单调。
4. 写 HTTP 契约测试：匿名 401、创建/读取信封、409 两种、跨用户 403/404、SSE 响应头。
5. 本机逐条执行能跑的部分；被门禁挡住的部分记录 `TEST_BLOCKED` 原因。
6. 汇总证据清单，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 只读账号对 `sales_orders` 执行 UPDATE | 数据库拒绝（权限错误） | 集成测试 |
| 2 | 同用户两个不同问题并发 POST | 只有一个活动 run，第二个 409 `RUN_IN_PROGRESS` | 集成测试 |
| 3 | 同 `(session_id, client_message_id)` 重复 POST | 返回同一 run_id，不新建 | 集成测试 |
| 4 | 用户 B 读用户 A 的会话快照与事件流 | 403 或 404，无内容泄露 | HTTP 契约 |
| 5 | 未登录 POST `/business-query/sessions` | 401 `UNAUTHENTICATED` 信封 | HTTP 契约 |
| 6 | `agent_runs` 部分唯一索引推演 | 约束存在且 WHERE 含三种活动状态 | 静态守卫 |
