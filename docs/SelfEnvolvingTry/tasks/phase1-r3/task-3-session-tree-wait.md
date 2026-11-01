# 任务 3：用 session/wait 收口批次

## 1. 任务位置

- 属于阶段一 `R-3 失败返工可追溯`，目标是根 Agent 首次 idle 不能提前结束构建批次。
- 本任务让 Worker 在 `run()` 后调用 SDK `session/wait`，再关闭 runtime。
- 开始条件是 Activation trace 可落盘；返工纵切等待本任务完成。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/sdk/client/README.md` — `run()` 与 `session/wait` 的语义差异是什么。
- `tmp/deepseek-harness/packages/sdk/server/src/server.ts` — wait 如何复核根 idle 与后代完成。
- `apps/coding-worker/src/runtime-lifecycle.ts` — runtime 所有权与关闭位置在哪里。
- `apps/coding-worker/test/runtime-lifecycle.test.ts` — 失败和关闭顺序如何验证。

**已定**

- 批次成功必须按 `run → session/wait → close` 排序。
- `run()` 失败时不调用 wait；wait 失败时保留原错误并关闭 runtime。
- 本任务不收集完整业务报告，只改变 Worker 的完成语义。

**边缘与接缝**

- 接触 `runCodingBatch()` 和注入式 runtime 测试。
- 接缝是 SDK 公开 `client.request('session/wait')`；不复制 SDK wait 实现。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- runtime-lifecycle`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若公开 client 不能安全注入测试替身，停止并缩小 runtime 接口；不访问 SDK 私有字段。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为成功路径的调用顺序写红测试。
3. 复用公开 SDK client request 实现 wait。
4. 加入 run 失败与 wait 失败用例。
5. 运行生命周期测试、真实 SDK smoke 和类型检查。
6. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | run 成功 | `run → wait → close` | `runCodingBatch()` |
| 2 | run 失败 | 不调用 wait，关闭一次 | `runCodingBatch()` |
| 3 | wait 失败 | 抛出 wait 错误，关闭一次 | `runCodingBatch()` |
| 4 | 固定父 Session | wait 使用同一 Session ID | SDK request |
| 5 | 真实 SDK 无后代 | wait 正常返回 | SDK runtime |

