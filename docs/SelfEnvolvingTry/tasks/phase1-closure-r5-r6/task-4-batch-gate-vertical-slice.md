## 1. Where this task sits

- **Phase 1 收口**，目标是双能力批次不返回部分候选。
- **R-6 一个母 Agent 统筹双工具并行**：共同批次身份和全有或全无门禁。
- **Starts after**：单父会话编排。**Waits on it**：阶段总结。

## 2. What the developer needs to know

**Read first**

- `src/candidate-batch.ts` — 全有或全无候选集合。
- `src/revision-evidence.ts` — 每项修订的验证绑定。
- `src/parallel-build.ts` — 既有进度事件形状。

**Settled**

- 成功必须返回两项候选和共同批次身份。
- 单项失败、缺项和重复提交不返回部分集合。
- 每项独立验证自己的冻结修订。

**Edges and seam**

- 触及批次汇总和门禁证据。
- 不注册生产工具或热重载。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- single-parent-batch candidate-batch`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 若任一能力没有可绑定的证据，整批保持拒绝。

## 3. The workflow

1. 阅读第 2 部分，并重述：任一能力失败时整批没有候选。
2. 写单项失败不返回部分集合的失败测试。
3. 汇总两项候选和共同批次身份。
4. 绑定每项独立门禁证据。
5. 加入缺项和重复提交反例。
6. 运行 focused tests 和类型检查。
7. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 两项通过候选 | 共同批次返回两项 | batch gate |
| 2 | 一项失败 | 不返回候选集合 | batch gate |
| 3 | 缺项 | 拒绝 | batch gate |
| 4 | 重复能力 | 拒绝 | batch gate |

