# T03 货号印上工艺单与采购单打印表

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §四.4
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-sales-order-item-no-schema.md)、[T02](./02-sales-order-item-no-api.md)（要有值可印）。

## 目标

货号出现在**纸上**：随单下给工厂的工艺单、发给供应商的采购单打印表。

为什么必须做：老板说「每个销售单多一个字段」，而后道工序（车间、供应商）看的是打印出来的单子，
字段只活在界面里等于没加。

## 关联决策

- 设计文档 §二：货号**不落下游表**，印刷时 join 销售单取值——所以采购单导出要多带一个关联字段，
  而不是加一列数据库列。
- 空值不留空盘位（沿用既有「空盘位自动省略」口径，见
  [sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md](../../design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md) §四）。

## 范围与非范围

**范围**

- `apps/api/src/modules/sales/sales-order-export.service.ts`：工艺单表头印货号。
- `apps/api/src/modules/procurement/purchase-order-export.service.ts`：打印表加货号。
- 两份导出测试各增补用例。

**非范围**

- 不改工艺流程单的其它版式（列宽、合并单元格、图片格留空的既有口径一律不动）。
- 不动生产单/领料单/QC 单的导出版式（它们按订单号工作，货号不是必需格）。
- 不做前端。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/sales/sales-order-export.service.ts` | 表头区加「货号」格（有值才印） |
| `apps/api/src/modules/procurement/purchase-order-export.service.ts` | `COLUMNS`（约 `:83`）加货号列、`headerLines`（约 `:277`）加货号行；查询补 `salesOrder: { select: { itemNo: true } }` |
| `apps/api/test/sales-order-production-sheet.test.cjs` | 增补 2 条 |
| `apps/api/test/purchase-order-export.test.cjs` | 增补 2 条 |

## 实施要点

**工艺单**

- 现在表头是「工厂 / 客户单号 / 客户代码 / 下单日期 / 数量 / 品名规格 / 地区 / 完工日期 / 注意事项」
  （见设计文档 §一.3）。货号挨着**品名规格**放（同一行或上一行），不要插到正唛/侧唛那块去。
- **有值才印**：老单没有货号，印出一个空格子会破坏既有断言与观感。
- 表尾的「明细合计 vs 单头数量」核对提示、制单人姓名口径一律不动。

**采购单打印表**

- 采购单本身没有货号列，取数路径是 `PurchaseOrder.salesOrder.itemNo`
  （采购单已有 `salesOrderId` 外键，`salesOrderNo` 现在是 `order.orderNo`，见 `:221`）。
  导出查询里加上 `salesOrder: { select: { itemNo: true } }`，document 上带 `itemNo`。
- 打印位置：`headerLines`（`:277`）里紧跟「订单号：」之后加「货号：」；
  `COLUMNS`（`:83`）里若加列，放在「产品名称」旁边。**两者选其一即可**，不要同一张表上重复印两遍——
  实现时按已有表头实际排版选，并在「完成记录」里写明选了哪种、为什么。
- 空货号时该行不印（同上，空盘位省略）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 有货号时工艺单表头出现该货号 | `sales-order-production-sheet.test.cjs`：导出后用 `xlsx` 回读断言 |
| 2 | 无货号时工艺单不产出空格、不报错、既有断言全绿 | 同上 + 全量回归 |
| 3 | 有货号时采购单打印表出现该货号 | `purchase-order-export.test.cjs` 回读断言 |
| 4 | 无货号时采购单打印表与改造前逐格一致 | 同上 |
| 5 | 任何单元格都不出现 UUID（全站既有口径） | 既有断言已覆盖，确认不破 |

命令：`npm run test:unit:api`（内部会先 build）。

> 回读式断言只能证明「格子里有这些字」，**证明不了观感**。本机没有 Excel/WPS，
> 真实打印观感（列宽、是否挤压相邻格）在「完成记录」里记为未验证项。

## 决策记录

- 采购单货号走**导出时 join 销售单**，不落 `purchase_orders` 列：列一落就有两个真源，
  改一次货号要改 N 张表，漏一张就出现「同一批货两种拼写」（设计文档 §二）。

## 完成记录

**2026-09-26 完成**（提交 `0e2c9f3`）。

- **选定方案与理由**（任务要求二选一并写明）：
  - **工艺单**：货号印在「完工日期」那一行。该行 `pairs()` 只用掉 A–C 三列、右边整片空着，
    补一格**不动任何行号/列号**；空货号时那一行与改造前逐格相同。
  - **采购单**：货号**并入「订单号」那一格**（`DL260001（货号 27621）`），**不新增列也不新增行**。
    理由：表头 12 格是用户逐项点名的（`HEADER_GRID_START` 的常量注释写着），明细表 9 列又牵着
    列宽、小计公式与边框循环 —— 为一个单元格去改列数或加第 5 行，代价是整张打印件行列号全面位移。
    没有货号时该格与改造前**逐字相同**。
- 交付物：`sales-order-export.service.ts`（`itemNo` 进 `document()` 与两个类型）；
  `purchase-order-export.service.ts`（`include()` 加 `salesOrder: { select: { itemNo: true } }`）；
  测试：工艺单 +2、采购单 +2。
- 验证：导出测试 24/24；`npm run typecheck` 通过；`npm run test:unit:api` **2048/2048**。
- **未验证**：两份导出的**打印观感**（列宽、是否挤压相邻格）没有在真实 Excel/WPS 里打开看过 ——
  回读断言只能证明"格子里有这些字"。部署后建议目测一次有货号的单。
