## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是让候选工具的字节集合可被独立验证。
- **R-3 实际生成与返工绑定真实修订**：冻结 Builder 写入目录的实现和测试，得到稳定哈希。
- **Starts after**：R-1 数据基线。**Waits on it**：Validator 返工和 ERP 门禁。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/revision-evidence.ts` — 当前能力和代码哈希证据契约。
- `apps/coding-worker/src/candidate-gate.ts` — 已有候选路径与符号链接防护。
- `apps/coding-worker/src/attempt-workspace.ts` — 每次 attempt 的目录边界。
- `phase1-closure-design-and-build-plan-2026-11-02.md` — 修订冻结的固定决定。

**Settled**

- 候选仅含实现、Builder 测试和清单；稳定路径排序后哈希。
- 目录冻结后以宿主只读副本交给验证，不信任 Agent 声明的哈希。
- 空目录、符号链接、越界文件和缺少入口都拒绝。

**Edges and seam**

- 触及 Worker 候选目录和修订证据；不调用模型或执行候选。
- 接缝是宿主 `freezeCandidateRevision()`。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- candidate-revision`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 既有固定候选的文件形状是否满足新清单。若不满足，保留旧回归并停止接入正式门禁。

## 3. The workflow

1. 阅读第 2 部分，并重述：宿主从真实目录计算候选修订。
2. 写空目录和符号链接的失败测试。
3. 实现稳定枚举和文件哈希，产出冻结清单。
4. 写修改源目录后冻结副本不变的测试。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 实现和测试文件 | 稳定清单和 SHA-256 | `freezeCandidateRevision()` |
| 2 | 空候选目录 | 拒绝 | `freezeCandidateRevision()` |
| 3 | 符号链接 | 拒绝 | `freezeCandidateRevision()` |
| 4 | 冻结后修改原目录 | 已冻结哈希不变 | `freezeCandidateRevision()` |
| 5 | 相同字节不同创建顺序 | 哈希相同 | `freezeCandidateRevision()` |
