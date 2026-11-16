# 领料数量改按实际入库数量扣减（2026-11-16，T-0012）

## 1. 需求原话

> 用户反馈，针对领料部分，要用实际入库数量去计算，不要用配料数量。比如 260136 单卡其伞布
> 配料数量是 5950 码，实际到货入库是 6470 码，生产领料时要用实际入库数量 6470 码去减去生产
> 领料数。系统当前还是用采购时预定的数量而不是实际到货的数量去扣减的，因此无法出库。

## 2. 改之前的实际情况

领料单的「余下数量」由 `material-slip-quantity.ts` 的 `remainingQuantity()` 计算，调用方传入的
基准是 BOM 的 `approvedUsage ?? requiredQuantity`：

- 配料 5950、已领 0、本次 6470 → 余下 **-520**，页面标红；
- 超领风险 `OVER_ISSUE_WARNING` 也拿 BOM `requiredQuantity` 比较，6470 会被误报「超出 BOM 用量」；
- 实际入库 6470 虽然已经在 `rawMaterialInbound` 里，但只用于「采购入库数量」展示，没有参与领料计算。

## 3. 新口径

**领料基准数量 = 该订单该物料已过账的实际入库数量（`status = posted` 的 `raw_material_inbound.quantity` 合计）；
没有入库记录时才回落到 BOM 配料数量。**

- 余下数量 = 领料基准数量 − 已领数量（不含本单）− 本次领料量；
- 超领风险也按领料基准数量判断：实际入库 6470 时领 6470 不再误报超 BOM；
- 配料数量列保留展示（BOM 参考），新增「实际入库数量」列，让纸面能看出 6470 的来源；
- 均为负数时照旧原样显示（不抹成 0），没有基准时留空。

## 4. 改动范围

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/production/material-slip-quantity.ts` | 新增 `issueReferenceQuantity()`：实际入库优先、BOM 兜底；`remainingQuantity()` 改为接受通用基准 |
| `apps/api/src/modules/production/raw-material-movements.service.ts` | 预估返回 `actual_inbound_quantity` / `issue_reference_quantity`；余下与超领风险改用实际入库 |
| `apps/api/src/modules/production/material-slip-export.service.ts` | 导出/打印同样查询实际入库；新增「实际入库数量」列；余下按实际入库计算 |
| `apps/web/components/production/material-slip-editor.tsx` | 「采购入库数量」更名为「实际入库数量」，余下增加口径提示 |
| `apps/web/components/production/material-issues-panel.tsx` | 草稿表新增「实际入库数量」列；超领标签改为「超出实际入库数量」 |
| `apps/web/components/production/material-slip-lines-table.tsx`、`apps/web/lib/material-slip-print.ts` | 详情与打印件增加「实际入库数量」列，页面与纸面同口径 |

## 5. 验证

- `npm run typecheck`（api / coding-worker / web）通过；
- API 定向用例：`material-slip-quantity`、`material-slip-export`、领料/补料提交与过账相关 53 条，修复后全部通过；
- 新增回归：BOM 5950 / 实际入库 6470，领 6470 时余下为 0、不产生 `OVER_ISSUE_WARNING`；实际入库 3000 时领 3500 显示 -500 并保留超领风险；
- Web 定向用例：领料编辑页、生产单面板、领料列表页、明细表、打印件共 88 条通过。

## 6. 未做 / 边界

- 未改数据库结构、未执行任何 migration；实际入库量仍由既有 `raw_material_inbounds` 动态汇总。
- 实际入库量按「订单号 + 物料」汇总，与原有「采购入库数量」一致；单位换算不在本轮范围。
- 没有入库记录的历史物料仍回落到 BOM，避免这些物料失去余下基准。
