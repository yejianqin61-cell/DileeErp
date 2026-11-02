# 任务 3：汇总并门禁整批候选

## 1. 任务位置

- 属于阶段一 `R-7 并行批次与可观察失败`，目标是一个能力失败时批次不产生可提交候选。
- 本任务收集各能力候选及独立验证结果，并执行整批准入判断。
- 开始条件是任务 2 可并行返回隔离结果；发布器和 Artifact Registry 不属于本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/candidate-gate.ts` — 单候选独立校验结果与拒绝原因。
- `apps/coding-worker/src/runtime-lifecycle.ts` — 批次结果结构当前如何定义。
- `apps/coding-worker/test/candidate-gate.test.ts` — 候选通过和拒绝的独立证据。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — 整批拒绝验收条件。

**已定**

- 只有所有能力都构建并通过独立门禁，批次才返回可提交候选集合。
- 任一失败时，批次结果不暴露部分候选为成功产物。
- Worker 门禁报告不是 ERP 发布批准，也不激活工具。

**边缘与接缝**

- 接触批次结果汇总与 Candidate Gate 的只读结果。
- 接缝是整批汇总函数；不写 Artifact Registry 或活动工具目录。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- candidate-batch candidate-gate`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Validator 报告不能绑定能力 ID 与候选哈希，批次必须拒绝，不推断对应关系。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 写双候选中一项验证失败的红测试。
3. 定义批次候选汇总输入和成功结果。
4. 要求每项报告绑定能力 ID 与候选哈希。
5. 实现全有或全无的整批准入判断。
6. 运行目标测试和类型检查。
7. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 两项能力均验证通过 | 返回完整候选集合 | 汇总函数 |
| 2 | 第二项构建失败 | 拒绝整批且不返回第一项候选 | 汇总函数 |
| 3 | 第二项验证失败 | 拒绝整批且保留失败证据 | 汇总函数 |
| 4 | 报告能力 ID 不匹配 | 拒绝整批 | 汇总函数 |
| 5 | 报告候选哈希不匹配 | 拒绝整批 | 汇总函数 |
