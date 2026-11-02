# 任务 1：归一化批次进度事件

## 1. 任务位置

- 属于阶段一 `R-7 并行批次与可观察失败`，目标是每个能力的构建进度都能按批次和轮次追踪。
- 本任务把 SDK 通知与 Cordis Activation 事件映射到稳定的 Worker 事件记录。
- 开始条件是 R-6 Activation trace 可读取；并行作业消费统一事件等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/activation-trace.ts` — 当前 Activation 记录格式和校验。
- `apps/coding-worker/src/runtime-lifecycle.ts` — SDK `run()` 返回结果与父会话等待。
- `apps/coding-worker/test/activation-trace.integration.test.ts` — 当前真实 Activation 事件证据。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — R-7 事件验收边界。

**已定**

- 事件必须包含 batch、capability、attempt、轮次、序号和来源类型。
- SDK 通知与 Activation 事件统一为进度记录，但保留来源字段。
- 事件解析遇到坏记录必须失败，不能静默跳过。

**边缘与接缝**

- 接触 Worker 批次事件类型、映射器及解析测试。
- 接缝是纯事件规范化函数；不写持久化队列或前端订阅。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- batch-progress-events activation-trace`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- SDK 通知字段若无法稳定关联能力或轮次，保留原始事件并标记未知，不猜测映射。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为 Activation 与 SDK 通知映射写失败用例。
3. 定义带批次、能力、尝试、轮次、序号和来源的事件。
4. 实现事件校验与规范化，并覆盖坏输入。
5. 运行目标测试和类型检查。
6. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 两种来源的有效事件 | 映射到同一事件结构且来源可区分 | 规范化函数 |
| 2 | 两个能力各自的相同轮次 | 能力标识保持不同 | 规范化函数 |
| 3 | 轮次缺失或序号倒退 | 解析失败 | 事件解析器 |
| 4 | 截断 JSONL 记录 | 返回行号错误 | 事件解析器 |
| 5 | 重复来源事件 | 保留来源并供后续幂等层识别 | 规范化函数 |
