## 1. Where this task sits

- **Phase 1 收口**，目标是一个母 Agent 统筹并行能力。
- **R-6 一个母 Agent 统筹双工具并行**：两项 Builder 共享父会话。
- **Starts after**：R-4 作业状态机。**Waits on it**：整批门禁纵切。

## 2. What the developer needs to know

**Read first**

- `src/parallel-build.ts` — 现有实现为何启动多个 Harness。
- `src/runtime-lifecycle.ts` — 单个父会话生命周期。
- `config/controlled-coding-tools.mjs` — Root 动作和 Activation 规则。

**Settled**

- 一批只启动一个 Harness 和一个父会话。
- Root 一次声明两个不同能力，再启动两个 Builder。
- Validator 只能在自己的 Builder 完成后开始。

**Edges and seam**

- 触及批次编排入口。
- 不改候选门禁或 ERP 发布。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- single-parent-batch`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 若 Harness 不能观察重叠区间，停止并保留单父会话证据。

## 3. The workflow

1. 阅读第 2 部分，并重述：两个 Builder 必须属于同一个父会话。
2. 写多个 Harness 被拒绝的失败测试。
3. 实现单父批次请求和能力目录。
4. 写两个 Builder Activation 重叠测试。
5. 验证 Validator 在对应 Builder 完成后才开始。
6. 运行 focused tests 和类型检查。
7. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 两项不同能力 | 一个 Harness、一个父会话 | batch runner |
| 2 | 两个 Builder | Activation 区间重叠 | activation trace |
| 3 | Validator | 晚于对应 Builder 完成 | activation trace |
| 4 | 重复能力 | 拒绝 | 输入检查 |

