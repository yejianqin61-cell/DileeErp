# P3-T2 销售领域 4 个 operation

## 1. 位置

- 阶段：Phase 3 非财务订单全链路。
- 本任务落销售领域：get_sales_order、get_customer、get_bom、get_sales_returns。
- 前置：P3-T1 的订单根验证器。后续采购/生产任务同模式。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/sales/sales-orders.service.ts` 的 `get()` — 版本、规格与物料引用口径；确认原返回里的单价/金额/客户完整对象要排除的字段名。
- `apps/api/src/modules/sales/boms.service.ts` — BOM 版本与明细排序口径。
- `apps/api/src/modules/warehouse/finished-goods-outbound.service.ts` 的 `listReturns()` — 退货单读取口径。
- `apps/api/prisma/schema.prisma` 的 SalesOrder/Bom/BomItem/SalesReturn（或成品出库退货）模型。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md` 映射表（sales_query 四行）。

**定案（不得重开）**

- 全部先过 `assertOrderRoot`；`get_customer` 只从已验证订单解析客户，**不得**调用无订单约束的客户池查询。
- `get_sales_order` 投影：单号、品名、数量、单位、状态、交期、创建/更新时间、（若有）版本/备注等非财务列；单价、金额、币种、客户完整对象一律排除。
- `get_customer` 投影：客户名称、编码（及 schema 上明确非财务的列）；**电话、地址、联系人一律不给**——这是待定口径，默认收紧，用户拍板放开前谁也不许加。
- `get_bom` 投影：版本、状态、明细（物料编码/名称、用量、单位）；排除 `reference_unit_price/reference_currency` 与快照里的财务键。
- `get_sales_returns` 投影：退货单号、数量、日期、状态；不透传自由原因文本、JSON、附件字段。
- 文件组织：`tools/sales-query-tools.ts`（新文件，第一个多查询领域）；executor 增分支。

**边界**

- 新文件 `tools/sales-query-tools.ts`；registry 4 个 op 翻开关；executor 增分支与输入解析。
- 不改业务模块。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-sales-domain.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 退货单的模型归属（finished_goods_outbound 的退货类型还是独立表）以 schema 为准；若退货与出库共用表，用单据类型过滤并在注释里写明口径。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写测试（红）：四个 op 各一到两个用例，全部喂「带财务字段的宽行」假数据。
3. 写 `sales-query-tools.ts` 四个实现 + 输入解析；executor 分支；registry 翻开关。
4. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 宽行销售单（带单价/金额/客户完整对象） | 投影只有白名单列，数量为字符串 | `get_sales_order` |
| 2 | 订单解析客户 | 只有名称/编码等允许字段，无电话/地址 | `get_customer` |
| 3 | BOM 明细带参考单价/币种 | 投影只有物料/用量/单位 | `get_bom` |
| 4 | 退货单带自由原因/附件字段 | 投影只有单号/数量/日期/状态 | `get_sales_returns` |
| 5 | 软删订单 | 404 `ORDER_NOT_FOUND` | 根验证器 |
