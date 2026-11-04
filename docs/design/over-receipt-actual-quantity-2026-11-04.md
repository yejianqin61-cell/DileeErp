# 超收（到货大于订购）与「按实收登记质检」2026-11-04

## 1. 问题

采购伞布 1500 码，供应商实际送到 1600 码。当前链路：

```
采购单（订购 1500）→ 登记到货（数量被"采购数量"约束）→ 来料质检 → 通知入库 → 原料入库 → 应付
```

- 到货登记超收时，后端 `PURCHASE_OVER_RECEIPT_REASON_REQUIRED` 会直接拦截；
- 即使到货只登记了 1500，来料质检也无法按 1600 登记：`incoming-inspections.service.ts`
  把「累计检验数量 ≤ 到货数量」当硬上限（`INSPECTION_QUANTITY_MISMATCH`）；
- 采购单详情里「编辑到货批次」的弹窗**没有**超收原因字段，PATCH 也从不发送
  `over_receipt_reason`，所以已登记的到货批次改不大。

结果：实收 1600 的事实无处登记，仓库入库、应付、报表都只能停在 1500。

## 2. 规则（本轮口径）

> **到货数量以实收为准；订购数量只是采购单上的计划数，不构成到货上限。**

1. **登记到货 / 编辑到货批次允许超过采购数量**。超收不再抛 422，改为记录：
   - `purchase_receipts.extension_data.over_receipt = true`
   - `over_receipt_reason`（选填，填了原样保存；原来的"必须填写"取消，超收事实本身即审计对象）
   - 审计事件 `purchase_receipt.create` / `purchase_receipt.update` 的详情里带 `over_receipt`
2. **来料质检按实收登记**。累计送检数量大于本批到货数量时，不再报"不能超过到货数量"，
   而是在同一事务里把该到货批次的 `quantity` 抬到累计实收量（只升不降），并记录：
   - `extension_data.over_receipt = true`、`over_receipt_corrected_from = <原到货数量>`、
     `over_receipt_reason = <质检备注/更正原因>`
   - 审计事件 `purchase_receipt.over_receipt`（含 from / to / source=incoming_inspection）
   - 之后 `入库可入量 = 合格 + 条件接收`、`应付 = 入库数量 × 单价` 都按 1600 走；采购单仍是 1500
3. **订购数量不动**。采购单明细 `quantity`、采购计划、BOM 需求都不因超收而改写；
   采购单详情到货列表对超收批次显示「超收」标记（悬停看原因）。
4. **不允许绕过质量门**：超收只影响数量，质检、入库、应付的既有门禁（拒收不可入库、
   下游事实存在不可改到货/质检、到货关闭后不可再到货等）全部保持不变。

## 3. 落点

| 层 | 文件 | 改什么 |
| --- | --- | --- |
| API | `apps/api/src/modules/procurement/incoming-inspections.service.ts` | `create` / `update`：超收时抬升到货数量（同事务）+ 审计 |
| API | `apps/api/src/modules/procurement/purchase-orders.service.ts` | `receipt` / `receiptV2` / `updateReceipt`：超收不再拦截，写 `over_receipt` 标记与原因 |
| Web | `apps/web/app/procurement/orders/[id]/page.tsx` | 编辑到货补「超收原因」字段并提交；到货批次显示「超收」 |
| Web | `apps/web/components/qc/incoming-inspections-panel.tsx` | 登记/编辑弹窗说明「超收按实收填、会自动修正到货数量」 |

## 4. 测试与验收

- API 单测：超收登记不再 422 且 `over_receipt=true`；质检实收 > 到货时到货被抬到实收量并审计；
  未超收时不写法。
- Web 测试：质检登记弹窗出现超收说明、送检 1600 不被前端拦；编辑到货弹窗能填超收原因并提交。
- 验收：`npm run test:unit:api`、`npm run test:unit:web`、`npm run typecheck`、`npm run build` 全绿，
  既有测试同步改口径。

## 5. 不做

- 不提供「超收审批/超额阈值」告警中心（上一轮设计文档里的超收告警维持现状：只在页面标记）。
- 不自动拆出「超收批次」独立单据；超收仍挂在原采购单的到货批次上。
- 不回填历史数据：已存在的到货/质检记录不被改写。
