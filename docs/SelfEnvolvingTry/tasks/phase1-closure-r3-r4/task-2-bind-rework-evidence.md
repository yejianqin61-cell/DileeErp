## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是拒绝旧修订和旧审查结果。
- **R-3 实际生成与返工绑定真实修订**：把 Validator 结论绑定到冻结修订和 Builder 会话。
- **Starts after**：冻结实际候选修订。**Waits on it**：真实模型返工实验。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/revision-evidence.ts` — 当前哈希匹配规则。
- `apps/coding-worker/src/job-policy.ts` — 返工轮次与预算规则。
- `apps/coding-worker/test/rework-loop.integration.test.ts` — 现有脚本模型返工证据。
- `phase1-closure-design-and-build-plan-2026-11-02.md` — R-3 的真实失败挑战要求。

**Settled**

- Validator 只审查冻结副本；报告必须含能力、修订、会话和 Activation。
- 同一 Builder 会话返工必须产生新修订；旧报告不能批准新字节。
- 本任务不伪称脚本模型等于真实模型。

**Edges and seam**

- 触及修订证据和工作策略；不实现模型 relay 或候选门禁。
- 接缝是 `evaluateRevisionEvidence()`。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- revision-evidence rework-loop`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- SDK 事件是否带完整 Activation。若缺少，停止并记录需要的 SDK 事件字段。

## 3. The workflow

1. 阅读第 2 部分，并重述：审批只适用于 Validator 实际审查的冻结字节。
2. 写旧报告批准新修订的失败测试。
3. 扩展证据契约，产出会话和 Activation 绑定。
4. 写同一修订重复返工被拒绝的测试。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 同能力同修订同会话 | 接受 | `evaluateRevisionEvidence()` |
| 2 | 旧修订报告 | 拒绝 | `evaluateRevisionEvidence()` |
| 3 | 错误 Builder 会话 | 拒绝 | `evaluateRevisionEvidence()` |
| 4 | 错误 Activation | 拒绝 | `evaluateRevisionEvidence()` |
| 5 | Validator 拒绝 | 拒绝 | `evaluateRevisionEvidence()` |
