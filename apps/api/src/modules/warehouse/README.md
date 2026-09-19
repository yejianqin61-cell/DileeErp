# Warehouse Module

仓库模块目录。库存分类和盘点规则已确定，成本与批次规则待确认。

## 目录内容

| 文件 | 职责 |
| --- | --- |
| `finished-goods-inventory.controller.ts` / `.service.ts` | 成品库存余额读模型（按生产单 + 产品名称快照 + 单位聚合） |
| `finished-goods-outbound.controller.ts` / `.service.ts` | 成品出库单、按出库通知分批建单、发货/签收/冲销、客户退货 |
| `finished-goods-qc.domain.ts` / `finished-goods-settlement.ts` | 成品 QC 与结算域规则 |
| `stocktake.controller.ts` / `.service.ts` / `stocktake-import.ts` | **库存盘点**：月度盘点表导入（纯函数解析 + 模板）→ 草稿校核 → 确认时写库存调整事实 → 冲销 |

这几个控制器没有自己的 `*.module.ts`（历史原因），统一注册在
`apps/api/src/modules/production/production.module.ts` 里。

## 库存口径（盘点依赖）

- 余额由 `inventory_facts` 聚合而来，**没有任何地方直接改余额**：
  原料 = `inventoryCategory ∈ {raw_material, scrap}` 的 `quantityDelta` 之和
  （见 `platform/inventory/inventory.service.ts`）；
- 盘点确认写的是 `source_type = stocktake_adjustment` 的数量事实，并回指 `stocktake_line_id`；
  冲销写等额反向事实（`stocktake_reversal`），历史事实不删除；
- 盘点不按库位分账：`仓位 / 货位` 只是盘点行的文本记录（V1 已确认不建库位/货架）。

设计见 [仓库库存盘点](../../../docs/design/stocktake-management-2026-09-16.md)，
盘点规则见 [仓库模块设计](../../../docs/design/warehouse-module-design.md) §6。
