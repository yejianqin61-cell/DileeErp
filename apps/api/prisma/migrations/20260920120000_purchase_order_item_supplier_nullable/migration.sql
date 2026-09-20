-- 采购明细行的供应商重新变成**可空**（用户 2026-09-17）。
--
-- 背景：刚「带入 BOM 明细」时每一行都还没选供应商。用户要求这一段也要能保存草稿
-- （原话：「导入 BOM 明细，也视为对采购单的编辑，允许保存」），否则草稿功能对主流程没用 ——
-- 30 行没填完供应商之前一个字都存不下来。
--
-- 这是 `20260908120000_purchase_order_item_supplier_expected_date` 里那条 SET NOT NULL 的**反向**改动。
-- 当时每张单都必须完整（连草稿也要求每行都有供应商），所以 NOT NULL 成立；
-- 现在草稿明确允许「还没定供应商」，约束就必须退回。
--
-- 「一个采购单只有一个供应商」的不变式**没有丢**，只是从数据库层挪到了两处业务门禁：
--   1. 下单门禁 `assertOrderableItems`：每一行都必须有供应商，否则 422 PURCHASE_ORDER_INCOMPLETE；
--   2. 写入门禁 `refs()`：一张单上不允许出现两个不同供应商（PURCHASE_ORDER_MULTIPLE_SUPPLIERS）。
-- 到货只能登记在已下单的采购单上，应付来源/应付单又都由到货或入库派生，
-- 所以任何有下游事实的明细行必然有供应商 —— 可空只影响「还没定供应商的草稿」。
--
-- 纯 DROP NOT NULL + 换外键动作，不改写任何数据、不删任何行。
ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_id" DROP NOT NULL;
ALTER TABLE "purchase_order_items" ALTER COLUMN "supplier_snapshot" DROP NOT NULL;

-- 外键动作必须跟着关系一起改：关系从「必填」变成「可选」后，Postgres 侧的
-- `ON DELETE RESTRICT` 就与 Prisma 的模型不一致了（Prisma 对可选关系一律生成 SET NULL），
-- 表现是 `prisma migrate diff` 会持续报 6 行漂移（DROP CONSTRAINT + ADD CONSTRAINT）。
-- 这也是本仓库既有口径：库里 8 条可选关系的外键动作全是 SET NULL（见 20260915120000 等迁移）。
-- 语义上也更对：供应商是可选引用，删供应商不该被一张「还没定供应商」的草稿行挡住，
-- 应当把这行的供应商置空（历史事实由行上的 supplier_snapshot 与审计保留）。
ALTER TABLE "purchase_order_items" DROP CONSTRAINT "purchase_order_items_supplier_id_fkey";
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
