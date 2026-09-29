-- 销售单货号 + 返单来源（2026-09-26）
--
-- 依据：docs/design/reorder-item-no-and-summary-2026-09-26.md §二
-- （老板原话：「每个销售单多一个字段，叫做货号。以后客户返单，从系统里面调取，返单客户货号不变。」）
--
-- 三条设计取舍，都写在这里，免得后来的人以为是漏了：
--   1. **不加 NOT NULL**：历史销售单没有货号。加 NOT NULL 会让这条迁移在真实库上直接失败，
--      也会把「确认销售单」这个既有动作变成破坏性变更。补录走
--      【返单与总结 → 未填货号】的待办表（逐条人工指派，绝不按品名猜）。
--   2. **不加唯一约束**：返单的本质就是「同一个货号多张销售单」，
--      唯一约束会把功能本身禁掉。
--   3. **不建自引用外键** 给 reorder_from_order_no：订单号本身已经唯一，
--      而返单链不该因为老单被删/改而断裂（老单删除是真实会发生的运维动作）。
--      存文本快照，展示时按订单号去查。
--
-- 货号**不冗余到采购/生产/QC**：那些表已经冗余了 order_no，再冗余货号就有两个真源，
-- 改一次货号要改 N 张表、漏一张就出现「同一批货两种拼写」。查询走
-- 「货号 → 订单号集合 → 下游 by orderNo」，正好用既有的 orderNo 索引。

ALTER TABLE "sales_orders"
  ADD COLUMN "item_no" VARCHAR(100),
  ADD COLUMN "reorder_from_order_no" VARCHAR(100);

CREATE INDEX "sales_orders_item_no_order_date_idx" ON "sales_orders"("item_no", "order_date");
