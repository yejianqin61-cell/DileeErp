# T-3 只读工具链与 search_orders

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路。
- 本任务落 R-1 只读业务边界与 R-5 的第一个能力：工具注册表、执行器、只读连接、`search_orders`。
- 前置：T-2 的 `resolveAccessLevel` 已就位。后续 T-4 编排器通过 Tool executor 调它。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/reports/reports.service.ts` 的 `orders()` — `search_orders` 沿用的搜索、状态与分页口径。
- `apps/api/src/platform/inventory/inventory.service.ts` — 独立 client 传参的模块内先例。
- `apps/api/src/platform/config/validate-environment.ts` — 新增 env 校验的落点。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「工具注册和查询执行如何划清责任」— executor 固定顺序与窄 DTO 规则。
- `docs/design/business-query-agent-v0-architecture-2026-10-23.md`「工具如何做到广覆盖」— 6 个领域工具与 operation 清单。

**定案（不得重开）**

- 模型只见 6 个领域工具：`order_query`、`sales_query`、`procurement_query`、`production_query`、`warehouse_query`、`finance_query`；Phase 1 只注册 `search_orders` 一个能力，其余 operation 声明存在但标记未实现并拒绝执行。
- `operational` 看不到 `finance_query`；`visibleTools(operational)` 返回 5 个。
- `search_orders` 投影固定 6 字段：单号、品名、数量（字符串）、单位、状态、交期；沿用 `ReportsService.orders()` 的软删与排序口径，每页上限 20。
- 工具 client 连 `AGENT_READ_DATABASE_URL`（缺省回退 `DATABASE_URL`，生产必须显式配置）；不注入全局 `PrismaService`。
- `QueryFact` 形状固定：`{operation, order_no, as_of, data, sources, access_level}`；来源含业务类型与查询时间。

**边界**

- 新文件：`tools/query-fact.ts`、`tools/tool-registry.ts`、`tools/tool-permission.ts`、`tools/tool-executor.ts`、`tools/order-query-tools.ts`、`query-read-client.ts`；`validate-environment.ts` 加生产校验。
- 不动任何业务模块与全局平台代码。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-registry.test.cjs apps/api/test/unit/agent-tool-executor.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 输入校验不引新库，按 operation 手写窄校验；若发现必须引 class-transformer 才能表达，停下来说明。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写 `query-fact.ts` 类型与 `tool-registry.ts`：6 工具声明 + `search_orders` 能力登记；先写 registry 测试（红）。
3. 写 `tool-permission.ts`：`assertOperationAllowed(accessLevel, tool, operation)`。
4. 写 `query-read-client.ts` 与 env 校验。
5. 写 `order-query-tools.ts`：`searchOrders` 窄投影；executor 测试用假只读 client（红→绿）。
6. 写 `tool-executor.ts`：固定顺序「查 registry → 验参数 → 重查档位 → 只读查询 → 投影 → 截断」。
7. 跑本任务两条命令，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | `visibleTools("operational")` | 5 个工具名，不含 `finance_query` | `visibleTools` |
| 2 | `visibleTools("full")` | 6 个工具名 | `visibleTools` |
| 3 | 未注册 operation `drop_table` | `definition` 与执行都拒绝 | `Tool executor` |
| 4 | 假只读 client 返回 2 张含价格字段的单 | 结果只有 6 个允许字段，数量为字符串 | `searchOrders` |
| 5 | 假只读 client 返回 30 行 | 结果截断到 20 行 | `Tool executor` |
| 6 | `operational` 调 `finance_query` | 拒绝且不触达 client | `Tool executor` |
| 7 | `q` 为空串或超长 | 校验拒绝，不触达 client | `Tool executor` |
