# T14 复盘增强：毛利、交期达成、合格率趋势与导出（P4）

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §七（P4）
> 批次：[README.md](./README.md)

## 状态

待认领（**P3 上线并观察一轮之后再开工**）

## 认领

负责人：
开始日期：

## 依赖

[T07](./07-reorder-articles-api.md)、[T08](./08-reorder-article-detail-api.md)、[T09](./09-reorder-documents-and-timeline-api.md)，
并且**汇总口径已被业务确认过一轮**（否则毛利算法一改，业务看到的"这个货赚不赚钱"会跟着变）。

## 目标

把 `/reorder` 从「查得到」提升到「看得出」：这个货号历次做下来赚不赚钱、交期守不守、质量稳不稳，
并能导出一张给老板看的总结表。

## 关联决策

- **不重算财务口径**：毛利、成本一律复用财务模块既有读服务，不在这里写第二套。
- 数字一律来自服务端；导出用既有 xlsx 写法（数值单元格口径见
  [export-numeric-cells-and-progress-sheet-2026-09-14.md](../../design/export-numeric-cells-and-progress-sheet-2026-09-14.md)）。

## 范围与非范围

**范围**

- 三个新口径：毛利、交期达成、合格率趋势。
- `GET /reorder/articles/:item_no/summary.xlsx`。
- `/reorder` 页面增补对应展示。
- 权限：金额类内容按**表面权限**过滤（「其他」角色看不到财务卡片/列，沿用工作台
  `apps/web/app/workbench.tsx:55-56` 的 `canVisitPath` 过滤做法）。

**非范围**

- 不做自定义报表设计器、不做按客户维度的利润分析（另有财务三大报表）。
- 不改财务模块的任何计算。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/reorder/reorder.module.ts` | `imports: [AuditModule, FinanceModule]`（先例：`hr.module.ts:10` 就是这么用财务服务的） |
| `apps/api/src/modules/reorder/reorder.service.ts` | 毛利/交期/趋势三个口径 |
| `apps/api/src/modules/reorder/reorder-export.service.ts` | 新建：xlsx 导出（照 `sales-order-export.service.ts` 的写法） |
| `apps/api/src/modules/reorder/reorder.controller.ts` | `@Get("articles/:item_no/summary.xlsx")`（**注意 `:item_no` 与路由顺序**） |
| `apps/web/components/reorder/*` | 汇总卡与趋势展示、导出按钮 |
| `apps/web/test/reorder-page.test.tsx` | 增补 |
| `apps/api/test/unit/reorder-summary.test.cjs` | 新建 |

## 实施要点

**1. 毛利：复用财务侧，不自己算**

- 财务模块已导出 `BomMaterialCostService`、`FinanceReportQueryService`、`CashFlowService` 等
  （见 `apps/api/src/modules/finance/finance.module.ts` 的 `exports`），
  而「销售利润报表(毛利)」在 `components/finance/finance-report-workspace.tsx` 已有实现。
- **做法**：`ReorderModule` 导入 `FinanceModule`，注入既有服务取该订单/该货号的成本与收入口径。
  逐字复用它与报表相同的调用方式，**不要**自己 join `BomItem`×`PurchaseOrderItem` 去算成本——
  那会立刻产生第二套成本口径（含"缺采购价物料 → 毛利偏高"那类既有提示，见该报表的表尾说明）。
- 缺成本价时**必须**把「毛利偏高/不可比」的说明一起返回，不能只给一个更好看的数。

**2. 交期达成**

- 口径：`SalesOrder.deliveryDate` vs 该批**最早过账出库**的 `FinishedGoodsOutbound.shipmentDate`
  （`status` 取已发货/已签收那档，与工作台"已出库"口径一致：`["posted","shipped","signed"]`）。
- 输出：`{ promised_date, actual_date, days_delta, verdict: "early" | "on_time" | "late" | "not_shipped" }`。
  未出货给 `not_shipped`，**不要**算成"准时"。
- 交期可能为空（`deliveryDate` 可空）→ `verdict: "no_promise"`，同样不要凑数。

**3. 合格率趋势**

- 按批次序列给 `[{ order_no, order_date, inspected, qualified, qualified_rate }]`；
  分母 0 → `null`（全站口径）。
- 只在**至少 2 批**有 QC 事实时画趋势（一批没有"趋势"可言，硬画会误导）。

**4. 导出**

- `GET /reorder/articles/:item_no/summary.xlsx`：一张表，列 =
  订单号 / 客户 / 下单日 / 交期 / 数量+单位 / 采购金额 / 应收金额 / 毛利 / QC 合格率 / 出库数量 / 交期结论。
- 数值格用既有数值单元格写法（不要写成文本），金额带币种列或标在表头，**同一列不混币种**。
- 文件名：`迪礼ERP-货号总结-<货号>.xlsx`（货号里的 `/` 等字符要替换，否则落盘会失败）。
- 表尾写上口径说明与"缺成本价的批次不参与毛利合计"的提示（照利润报表表尾的做法）。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 毛利与财务「销售利润报表」同订单同值 | `unit/reorder-summary.test.cjs`（交叉断言） |
| 2 | 缺成本价时返回"不可比"标记而不是一个更大的毛利 | 同上 |
| 3 | 交期四态（提前/准时/逾期/未出货）+ 无交期 → `no_promise` | 同上 |
| 4 | 合格率分母 0 → `null`；只有 1 批时不给趋势数组 | 同上 |
| 5 | 导出能被 `xlsx` 回读；金额格是数字不是文本 | 同上 |
| 6 | 金额列在「其他」角色下不渲染（表面权限过滤） | `reorder-page.test.tsx` |
| 7 | 文件名里的非法字符被替换 | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api` → `cd apps/web; npm run test:unit`。

## 决策记录

- **复用 FinanceModule 而不是自己算成本**：见实施要点 1。
- **P4 门槛**：本任务开工前先确认 P3 的汇总口径（数量/金额分行、合格率分母）业务认可，
  否则改口径会同时改动两处。

## 完成记录

（认领后填写。）
