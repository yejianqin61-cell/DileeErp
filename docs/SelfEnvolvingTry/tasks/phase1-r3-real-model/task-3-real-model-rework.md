## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是实际模型写文件并产生可核验返工。
- **R-3 实际生成与返工绑定真实修订**：用 relay 驱动 Builder 和 Validator，冻结每次文件修订。
- **Starts after**：relay 通过。**Waits on it**：独立 ERP 门禁。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/candidate-revision.ts` — 冻结的字节证据。
- `apps/coding-worker/src/revision-evidence.ts` — Builder/Validator 绑定。
- `apps/coding-worker/src/runtime-lifecycle.ts` — Harness 生命周期。

**Settled**

- 实验从空候选目录开始，提示不含业务数据。
- 首版失败由宿主固定挑战触发；旧哈希不可作为新修订证据。

**Edges and seam**

- 触及真实模型实验入口；不激活候选或改 ERP 数据。
- 接缝是 `runCodingBatch()` 后的冻结与证据检查。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- real-model-rework`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- DSH 的生产 provider 名称和 base URL 配置。若不支持 relay，停止并保存无密钥错误摘要。

## 3. The workflow

1. 阅读第 2 部分，并重述：真实模型生成后必须由宿主冻结和重验。
2. 写无 relay 配置时失败的测试。
3. 连接 relay 和 Harness，产出真实模型运行记录。
4. 冻结首版、注入挑战并请求原 Builder 修订，产出新哈希。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 缺 relay 配置 | 明确失败 | 真实实验入口 |
| 2 | 空候选目录 | 模型写出实现和测试 | `runCodingBatch()` |
| 3 | 固定首版挑战 | 新修订哈希不同 | 修订冻结 |
| 4 | 旧 Validator 报告 | 不批准新修订 | 修订证据 |
