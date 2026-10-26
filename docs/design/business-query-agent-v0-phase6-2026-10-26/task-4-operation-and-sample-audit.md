## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：31 个 operation 与关键订单口径可追溯。
- **本任务推进 R-5 完整只读工具集、R-12 数据口径与来源**：把目录和样例对照收为发布证据。
- **开始于** Task 2。**后续等待它**：真实模型验收与签核。

## 2. What the developer needs to know

**Read first**

- `tool-registry.ts` — 已登记 operation 的权威目录。
- `agent-tool-catalog-audit.test.cjs` — 目录完整性检查。
- `business-query-operations.test.cjs` — 领域 operation 的集成证据。
- `module-design-2026-10-25.md` — 每个 operation 的业务口径。

**Settled**

- 目录计数与最低档位由注册表决定。
- 关键订单对照以既有页面/报表为权威，不以模型措辞为准。

**Edges and seam**

- 触及 registry 审计与验收记录。保留 operation 定义。

**Run**

- `npm run test:integration --workspace=@dilee/api`
- `node --test apps/api/test/unit/agent-tool-catalog-audit.test.cjs`

**Unknowns**

- 没有预发布代表订单时，只完成目录审计并记录样例对照待办。

## 3. The workflow

1. 阅读第 2 部分并复述：目录齐全不等于真实订单口径已签核。
2. 先运行 31 项目录审计。
3. 为六领域选取脱敏代表订单。
4. 将工具事实逐项对照既有页面或报表。
5. 记录差异、来源和账户档位。
6. 提交审计记录。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 注册表 | 31 项均存在 | registry |
| 2 | operational 目录 | 不含财务 operation | registry |
| 3 | full 目录 | 含 7 项财务 operation | registry |
| 4 | 代表订单 | 工具事实与页面一致 | 预发布查询 |
