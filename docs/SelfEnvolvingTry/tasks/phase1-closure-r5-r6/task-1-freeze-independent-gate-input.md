## 1. Where this task sits

- **Phase 1 收口**，目标是 ERP 宿主不信任 Builder 交出的候选目录。
- **R-5 ERP 独立重验整个候选**：冻结候选、副本和绑定证据。
- **Starts after**：R-3 修订证据。**Waits on it**：独立门禁重跑。

## 2. What the developer needs to know

**Read first**

- `src/candidate-gate.ts` — 现有 manifest 和哈希检查缺少什么。
- `src/candidate-revision.ts` — 修订哈希如何冻结字节。
- `src/revision-evidence.ts` — Builder/Validator 绑定字段。

**Settled**

- 宿主从候选目录复制到新目录后才运行验证。
- 实现、测试、Validator 报告和宿主结果绑定同一能力、修订和基线。
- 缺文件、链接或副本写入一律拒绝。

**Edges and seam**

- 触及 Worker 独立门禁输入。
- 不改 ERP 发布或活动 Registry。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- independent-gate`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 若候选测试需要未批准依赖，停止并拒绝该候选。

## 3. The workflow

1. 阅读第 2 部分，并重述：门禁只读取宿主冻结副本。
2. 写篡改原目录不影响副本的失败测试。
3. 复制白名单文件并记录绑定证据。
4. 拒绝缺文件、符号链接和不匹配证据。
5. 运行 focused tests 和类型检查。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 完整候选 | 冻结副本和绑定哈希 | `freezeGateInput()` |
| 2 | 冻结后篡改原目录 | 副本字节不变 | 副本目录 |
| 3 | 缺生成测试 | 拒绝 | 输入检查 |
| 4 | 符号链接 | 拒绝 | 输入检查 |

