## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：关闭 Agent 后原业务系统继续工作。
- **本任务推进 R-13 可发布与可回退**：提供不删会话数据的入口关闭路径。
- **开始于** Task 1。**后续等待它**：发布签核。

## 2. What the developer needs to know

**Read first**

- `query-permission.guard.ts` — 所有 Agent 路由的统一授权缝。
- `business-query-agent.module.ts` — Agent 模块的装配位置。
- `validate-environment.ts` — 环境配置的验证模式。
- `business-query-contract.test.cjs` — 业务查询路由的外部契约。

**Settled**

- 回退只关闭 Agent 入口和新模型调用，不删 `agent_*` 数据。
- 非 Agent 业务 API 不受开关影响。

**Edges and seam**

- 触及 Agent 统一守卫和生产配置。保留业务路由。

**Run**

- Agent HTTP 契约测试。
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若统一守卫无法覆盖全部 Agent 路由，停止并先补路由清单。

## 3. The workflow

1. 阅读第 2 部分并复述：关闭入口不是删除历史数据。
2. 写开关关闭时的 Agent 路由失败用例。
3. 在统一授权缝增加最小关闭条件。
4. 验证正常启用、关闭拒绝和非 Agent API 不变。
5. 写预发布切换与恢复记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 开关启用 | Agent 路由照常工作 | guard |
| 2 | 开关关闭 | Agent 路由稳定拒绝 | guard |
| 3 | 开关关闭 | Agent 状态数据保留 | state client |
| 4 | 开关关闭 | 非 Agent API 正常 | HTTP 路由 |
