# 任务 3：强制 Worker 截止时间

## 1. 任务位置

- 属于阶段一 `R-4 Cordis 与 Worker 强制规则`，目标是整批超时后不能留下可复用 runtime。
- 本任务让一次 Coding Batch 的 `run()` 与 `session/wait` 共用一个 Worker 截止时间。
- 开始条件是 R-3 已有 runtime 所有权和全树等待；真实超时纵切等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/runtime-lifecycle.ts` — runtime 现在怎样启动、等待和关闭。
- `apps/coding-worker/test/runtime-lifecycle.test.ts` — 失败与关闭顺序怎样验证。
- `tmp/deepseek-harness/packages/sdk/client/src/dispose.ts` — `close()` 何时证明 runtime 已退出。
- `docs/SelfEnvolvingTry/business-query-agent-deepseek-harness-sdk-phase1-2026-10-29.md` — 为什么超时必须废弃整批 runtime。

**已定**

- 截止时间覆盖 `run()` 和 `session/wait`，不能各自重新计时。
- 超时返回稳定 Worker 错误，并等待 `close()` 完成后才向调用方结束。
- 超时 runtime 永不复用；容器级后代清理仍由生产部署边界负责。

**边缘与接缝**

- 只接触 `runCodingBatch()` 及其生命周期测试。
- 接缝是 Worker 批次入口；不增加 prompt 级取消，也不修改 SDK。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- runtime-lifecycle worker-deadline`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 SDK `close()` 不能在测试窗口内确认退出，停止并保留清理错误，不吞掉双重失败。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为永不结束的 `run()` 写超时红测试。
3. 加入整批截止时间和稳定错误，再跑绿。
4. 加入 `session/wait` 超时与关闭失败组合用例。
5. 运行目标测试和类型检查。
6. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | `run()` 超过截止时间 | `CODING_BATCH_TIMEOUT` | `runCodingBatch()` |
| 2 | `session/wait` 超时 | 同一稳定超时错误 | `runCodingBatch()` |
| 3 | 超时后关闭成功 | 返回前已调用并等待关闭 | runtime 工厂 |
| 4 | 超时且关闭失败 | 两个错误都保留 | `runWithCodingRuntime()` |
| 5 | 未配置截止时间 | 保持现有成功行为 | `runCodingBatch()` |

