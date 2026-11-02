# 任务 4：清理失败并隔离新尝试

## 1. 任务位置

- 属于阶段一 `R-7 并行批次与可观察失败`，目标是失败、超时或取消后不遗留可复用执行资源。
- 本任务在批次终止时收拢所有 runtime，并确保重试使用新 attempt 和新候选目录。
- 开始条件是任务 2、3 的并行执行与整批拒绝可用；完整故障注入纵切等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/runtime-lifecycle.ts` — Worker 截止时间和 runtime 关闭顺序。
- `apps/coding-worker/test/worker-deadline.test.ts` — 超时与双重清理错误行为。
- `apps/coding-worker/test/rework-loop.integration.test.ts` — 返工 attempt 证据如何隔离。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — 关口取消与新 attempt 验收。

**已定**

- 单能力失败、重复通知、Worker 失联或强制取消都不能提交部分候选。
- 终止批次必须等待已创建 runtime 关闭，并保留执行与清理错误。
- 每次重试使用新 attempt ID 和新候选目录，旧证据不得复用。

**边缘与接缝**

- 接触批次终止、取消信号和 attempt 隔离测试。
- 接缝是批次 Worker 入口；容器外部的宿主进程树清理由部署边界负责。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- parallel-build worker-deadline rework-loop`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Harness `close()` 不能证明进程退出，保留清理失败并停止批次，不报告已清理。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 写一个能力失败后等待全部 runtime 关闭的红测试。
3. 加入幂等事件处理，重复完成通知不重复提交。
4. 加入强制取消并等待所有 runtime 收尾。
5. 为重试分配新 attempt ID 和隔离目录。
6. 注入失联和失败，运行目标测试及类型检查。
7. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 一个 Builder 失败、另一个仍运行 | 批次等待两者关闭后拒绝 | 批次 Worker 入口 |
| 2 | 同一完成通知到达两次 | 只记录一次完成和一次汇总 | 事件消费器 |
| 3 | 批次达到截止时间 | 取消并等待所有 runtime 关闭 | 批次 Worker 入口 |
| 4 | 新 attempt 重用旧目录请求 | 校验拒绝旧路径 | attempt 分配器 |
| 5 | 执行与关闭同时失败 | 两个错误均可观察 | 批次 Worker 入口 |
