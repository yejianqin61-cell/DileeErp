-- 生产、外协与库存 11 张表补 sales_order_id 外键（阶段 5 / R-8）。
-- 清单与口径：docs/design/order-no-fk-inventory-2026-10-27.md
-- 只加可空列 + 回填历史行 + 外键，不改写入点（写入点归阶段 6）。

ALTER TABLE "outsource_logistics_batches" ADD COLUMN "sales_order_id" UUID;
UPDATE "outsource_logistics_batches" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "outsource_logistics_batches_sales_order_id_idx" ON "outsource_logistics_batches"("sales_order_id");

ALTER TABLE "outsource_receipts" ADD COLUMN "sales_order_id" UUID;
UPDATE "outsource_receipts" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "outsource_receipts" ADD CONSTRAINT "outsource_receipts_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "outsource_receipts_sales_order_id_idx" ON "outsource_receipts"("sales_order_id");

ALTER TABLE "outsource_payable_sources" ADD COLUMN "sales_order_id" UUID;
UPDATE "outsource_payable_sources" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "outsource_payable_sources_sales_order_id_idx" ON "outsource_payable_sources"("sales_order_id");

ALTER TABLE "outsource_return_transfers" ADD COLUMN "sales_order_id" UUID;
UPDATE "outsource_return_transfers" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "outsource_return_transfers_sales_order_id_idx" ON "outsource_return_transfers"("sales_order_id");

ALTER TABLE "outsource_direct_shipments" ADD COLUMN "sales_order_id" UUID;
UPDATE "outsource_direct_shipments" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "outsource_direct_shipments" ADD CONSTRAINT "outsource_direct_shipments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "outsource_direct_shipments_sales_order_id_idx" ON "outsource_direct_shipments"("sales_order_id");

ALTER TABLE "raw_material_movements" ADD COLUMN "sales_order_id" UUID;
UPDATE "raw_material_movements" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "raw_material_movements" ADD CONSTRAINT "raw_material_movements_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "raw_material_movements_sales_order_id_idx" ON "raw_material_movements"("sales_order_id");

ALTER TABLE "operation_daily_reports" ADD COLUMN "sales_order_id" UUID;
UPDATE "operation_daily_reports" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "operation_daily_reports_sales_order_id_idx" ON "operation_daily_reports"("sales_order_id");

ALTER TABLE "employee_daily_reports" ADD COLUMN "sales_order_id" UUID;
UPDATE "employee_daily_reports" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "employee_daily_reports_sales_order_id_idx" ON "employee_daily_reports"("sales_order_id");

ALTER TABLE "production_daily_alerts" ADD COLUMN "sales_order_id" UUID;
UPDATE "production_daily_alerts" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "production_daily_alerts" ADD CONSTRAINT "production_daily_alerts_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "production_daily_alerts_sales_order_id_idx" ON "production_daily_alerts"("sales_order_id");

ALTER TABLE "production_payroll_sources" ADD COLUMN "sales_order_id" UUID;
UPDATE "production_payroll_sources" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "production_payroll_sources" ADD CONSTRAINT "production_payroll_sources_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "production_payroll_sources_sales_order_id_idx" ON "production_payroll_sources"("sales_order_id");

ALTER TABLE "inventory_facts" ADD COLUMN "sales_order_id" UUID;
UPDATE "inventory_facts" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inventory_facts_sales_order_id_idx" ON "inventory_facts"("sales_order_id");

