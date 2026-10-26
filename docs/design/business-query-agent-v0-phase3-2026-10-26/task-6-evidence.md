# P3-T6 证据收口：24 op 审计、财务红线扫描与同单据对照

## 1. 位置

- 阶段：Phase 3 的验收证据。
- 本任务落三件证据：注册表审计（24 个非财务 op 全部可用、7 个财务 op 仍拒绝）、**财务红线扫描**（每个 op 的结果 JSON 不含任何财务词）、同单据对照（agent 实现与现有服务在同库同数据下数量一致）。
- 前置：P3-T1 至 P3-T5 全部完成。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — 能力目录结构与 implemented 开关。
- `apps/api/test/unit/agent-tool-executor.test.cjs` — 假只读 client 的喂宽行模式。
- `apps/api/test/integration/business-query-agent.test.cjs` — 集成测试的库准备/清理惯例与 fixture 模式。
- `scripts/seed-mock-data.mjs` — 是否已有可用的订单链路种子（决定 fixture 自建还是用种子）。
- `docs/design/business-query-agent-v0-development-plan-2026-10-25.md` 阶段 3「证据」。

**定案（不得重开）**

- **审计单测**：`TOOL_CAPABILITIES` 中非财务 24 个 op 全部 `implemented: true` 且 minAccess=operational；财务 7 个 `implemented: false` 且 operational 调用被拒（422 未实现 + 403 越权两条路都验）。
- **红线扫描单测**：财务词表 `unit_price|total_amount|amount|currency|price|payable|receivable|salary|wage|bank|settlement|balance_cny`；对 24 个 op 各喂一次「宽行含全部财务字段」的假数据，结果 JSON 不得命中词表。这条是本批最强守卫，防的是**未来**加 op 时漏投影。
- **同单据对照（集成）**：fixture 自建一条最小链路（销售单→BOM→采购单→到货→质检→生产单→报工→库存事实→成品入库/出库），对每个已实现 op 断言：根验证 404 路径、行数与关键字段值等于直接查库的期望值（数量、单位、状态口径）。不逐字段对齐现有服务的响应形状（那是新投影的本意），对齐的是**业务数值**。
- 本机无库惯例不变：静态/单测全绿必须；集成标注环境门禁，能跑就跑并记录。

**边界**

- 新文件：`apps/api/test/unit/agent-tool-catalog-audit.test.cjs`、`apps/api/test/integration/business-query-operations.test.cjs`。
- 不改产品代码；暴露缺陷回对应领域任务修复后另起 `fix(...)` 提交。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-catalog-audit.test.cjs apps/api/test/unit/agent-tool-order-domain.test.cjs apps/api/test/unit/agent-tool-sales-domain.test.cjs apps/api/test/unit/agent-tool-procurement-domain.test.cjs apps/api/test/unit/agent-tool-production-domain.test.cjs apps/api/test/unit/agent-tool-warehouse-domain.test.cjs`
- `npm run test:integration`（需 `TEST_DATABASE_URL`；容器复跑命令见 docs/log/2026-10-25.md）

**未知**

- 红线词表可能误伤合法字段（如未来的 `settlement_date` 属结算口径，本来就该拦）；词表增减必须连着模块设计过一遍，不许静默扩。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写审计单测（红→绿）：24+7 的开关矩阵与双路拒绝。
3. 写红线扫描单测（红→绿）：24 op × 宽行假数据 × 财务词表。
4. 写集成对照：fixture 链路 + 逐 op 数值断言；起临时容器跑齐并记录输出。
5. 汇总证据清单，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 能力目录 | 非财务 24 个 implemented，财务 7 个未实现 | `TOOL_CAPABILITIES` |
| 2 | operational 调财务 op | 403（越权）与 422（未实现）双路拒绝 | `Tool executor` |
| 3 | 24 op × 财务宽行假数据 | 结果 JSON 不命中财务词表 | 红线扫描 |
| 4 | fixture 链路（集成） | 各 op 的数量/单位/状态与直查库一致 | 各领域实现 |
| 5 | fixture 中软删单据 | 根验证 404，关联查询不带回软删行 | 各领域实现 |
