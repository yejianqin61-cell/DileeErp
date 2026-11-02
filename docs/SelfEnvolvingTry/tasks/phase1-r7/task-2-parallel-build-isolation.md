# 任务 2：并行构建隔离能力

## 1. 任务位置

- 属于阶段一 `R-7 并行批次与可观察失败`，目标是多个工具能力可同时构建并单独验证。
- 本任务增加双能力批次入口，为每个 Builder 分配独立工作目录和运行标识。
- 开始条件是任务 1 的统一事件契约完成；整批汇总依赖本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/runtime-lifecycle.ts` — 单个 Harness runtime 的所有权与关闭。
- `apps/coding-worker/src/activation-trace.ts` — Session 与 Activation 的追踪字段。
- `apps/coding-worker/test/parent-child.integration.test.ts` — 真实 Harness 父子会话样例。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — 双能力并行验收要求。

**已定**

- 每项能力有稳定 ID、独立候选目录和独立 Builder Session。
- 多能力构建可并行运行，完成结果按请求顺序汇总。
- 每个 runtime 均由 Worker 创建并关闭，不能共享可写候选目录。

**边缘与接缝**

- 接触 Worker 双能力批次构建入口及其生命周期测试。
- 接缝是批次构建函数；不修改 Harness SDK 或 Builder prompt 策略。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- parallel-build`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Harness runtime 不能并发启动，停止并记录真实限制，不用共享实例伪造并发。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 写双能力同时存活且目录不同的红测试。
3. 定义能力输入、隔离目录和结果结构。
4. 并发启动独立批次 runtime，并关联统一进度事件。
5. 验证结果顺序稳定且每个 runtime 均关闭。
6. 运行目标测试和类型检查。
7. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 两个独立能力请求 | 两个 Builder 同时运行 | 批次构建函数 |
| 2 | 两个能力同时写候选 | 输出目录互不相同 | 能力工作区分配 |
| 3 | 完成顺序与请求顺序相反 | 返回结果仍按请求顺序 | 批次构建函数 |
| 4 | 一个 runtime 初始化失败 | 已创建的 runtime 全部关闭 | 批次构建函数 |
| 5 | 空能力列表 | 输入校验拒绝批次 | 批次构建函数 |
