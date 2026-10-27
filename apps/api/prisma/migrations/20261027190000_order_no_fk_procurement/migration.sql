-- 采购链路 5 张表补 sales_order_id 外键（阶段 5 / R-8）。
-- 清单与口径：docs/design/order-no-fk-inventory-2026-10-27.md
--
-- 只加可空列 + 回填历史行 + 外键，不改任何写入点（写入点归阶段 6）。
-- 回填只认未软删的销售单；对不上任何销售单的行保持 NULL。

ALTER TABLE "purchase_receipts" ADD COLUMN "sales_order_id" UUID;
UPDATE "purchase_receipts" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "purchase_receipts_sales_order_id_idx" ON "purchase_receipts"("sales_order_id");

ALTER TABLE "incoming_inspections" ADD COLUMN "sales_order_id" UUID;
UPDATE "incoming_inspections" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "incoming_inspections" ADD CONSTRAINT "incoming_inspections_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "incoming_inspections_sales_order_id_idx" ON "incoming_inspections"("sales_order_id");

ALTER TABLE "raw_material_inbound_notices" ADD COLUMN "sales_order_id" UUID;
UPDATE "raw_material_inbound_notices" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "raw_material_inbound_notices_sales_order_id_idx" ON "raw_material_inbound_notices"("sales_order_id");

ALTER TABLE "raw_material_inbounds" ADD COLUMN "sales_order_id" UUID;
UPDATE "raw_material_inbounds" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "raw_material_inbounds_sales_order_id_idx" ON "raw_material_inbounds"("sales_order_id");

ALTER TABLE "payable_sources" ADD COLUMN "sales_order_id" UUID;
UPDATE "payable_sources" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payable_sources_sales_order_id_idx" ON "payable_sources"("sales_order_id");

