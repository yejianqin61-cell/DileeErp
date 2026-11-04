# P2-T1 并发许可闸与 429

## 1. 位置

- 阶段：Phase 2 DeepSeek、上下文与运行控制，目标是并发/取消/超窗都有可预测结果。
- 本任务落 R-8 小规模并发控制：进程内最多 4 个活动 run，无空位 429，不建队列。
- 前置：阶段 1 已交付（编排器、控制器、状态管理器）。后续 T-5 的五用户并发证据对准它。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/business-query-agent/business-query-agent.controller.ts` 的 `createRun` — 闸门插在幂等检查之后、建 run 之前。
- `apps/api/src/modules/business-query-agent/business-query-agent.module.ts` — provider 注册方式。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「并发控制具体怎样工作」— 步骤顺序与竞态处理。
- `apps/api/test/unit/agent-state-manager.test.cjs` — 内存假对象的测试风格。

**定案（不得重开）**

- `ConcurrencyGate.tryAcquire(userId)`：进程内至多 4 个活动许可；成功返回 `{ release() }`，无空位返回 `Busy`；不排队、不缓存问题。
- 每用户一个活动 run 已由数据库部分唯一索引与 `hasActiveRun` 承担，闸门只管**总负载**。
- 无空位：HTTP 429、信封 code `AGENT_BUSY`、响应头 `Retry-After: 3`；不创建 run。
- 释放只由编排器 `finally` 做；抛错、取消、完成三条路都释放。
- 多副本部署前这是进程内语义（模块设计原文），文档注释要写明。

**边界**

- 新文件：`concurrency-gate.ts`；改 `business-query-agent.controller.ts`（插闸 + Retry-After 头）与 module 注册。
- 不动状态管理器与编排器内部。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-concurrency-gate.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- Retry-After 头经 passthrough `@Res` 设置；若与现有参数注入冲突，先查 Nest 对 `@Res({passthrough:true})` 与拦截器的交互，不改信封拦截器。

## 3. 工作流

1. 读上面 4 处，然后一句话复述本任务。
2. 写 `agent-concurrency-gate.test.cjs`（红）：4 许可内成功、第 5 个 Busy、release 后可再取、`finally` 抛错仍释放。
3. 写 `concurrency-gate.ts` 实现，跑到绿。
4. 控制器接闸：幂等检查后 `tryAcquire`；busy 时 setHeader(`Retry-After`,`3`) + 抛 429 `AGENT_BUSY`；编排器启动包 `finally(release)`。
5. 跑本任务两条命令 + 全量 agent 单测回归。
6. 提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 依次 acquire 4 次 | 都成功，4 个 permit | `tryAcquire` |
| 2 | 第 5 次 acquire（未释放） | `Busy`，无副作用 | `tryAcquire` |
| 3 | release 一个后再 acquire | 成功 | `tryAcquire` |
| 4 | permit 持有者抛异常，finally 里 release | 计数回到可再取 | 调用方模式 |
| 5 | 同一 userId 两次 acquire | 都放行（单用户约束归数据库管） | `tryAcquire` |
