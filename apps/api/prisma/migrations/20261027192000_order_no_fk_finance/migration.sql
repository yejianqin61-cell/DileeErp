-- 成品与财务 11 张表补 sales_order_id 外键（阶段 5 / R-8）。
-- 清单与口径：docs/design/order-no-fk-inventory-2026-10-27.md
-- 只加可空列 + 回填历史行 + 外键，不改写入点（写入点归阶段 6）。

ALTER TABLE "finished_goods_inspection_submissions" ADD COLUMN "sales_order_id" UUID;
UPDATE "finished_goods_inspection_submissions" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "finished_goods_inspection_submissions" ADD CONSTRAINT "finished_goods_inspection_submissions_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "finished_goods_inspection_submissions_sales_order_id_idx" ON "finished_goods_inspection_submissions"("sales_order_id");

ALTER TABLE "finished_goods_qc_records" ADD COLUMN "sales_order_id" UUID;
UPDATE "finished_goods_qc_records" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "finished_goods_qc_records" ADD CONSTRAINT "finished_goods_qc_records_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "finished_goods_qc_records_sales_order_id_idx" ON "finished_goods_qc_records"("sales_order_id");

ALTER TABLE "finished_goods_inbound_notices" ADD COLUMN "sales_order_id" UUID;
UPDATE "finished_goods_inbound_notices" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "finished_goods_inbound_notices_sales_order_id_idx" ON "finished_goods_inbound_notices"("sales_order_id");

ALTER TABLE "finished_goods_inbounds" ADD COLUMN "sales_order_id" UUID;
UPDATE "finished_goods_inbounds" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "finished_goods_inbounds" ADD CONSTRAINT "finished_goods_inbounds_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "finished_goods_inbounds_sales_order_id_idx" ON "finished_goods_inbounds"("sales_order_id");

ALTER TABLE "finished_goods_defectives" ADD COLUMN "sales_order_id" UUID;
UPDATE "finished_goods_defectives" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "finished_goods_defectives" ADD CONSTRAINT "finished_goods_defectives_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "finished_goods_defectives_sales_order_id_idx" ON "finished_goods_defectives"("sales_order_id");

ALTER TABLE "supplier_payable_entries" ADD COLUMN "sales_order_id" UUID;
UPDATE "supplier_payable_entries" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "supplier_payable_entries_sales_order_id_idx" ON "supplier_payable_entries"("sales_order_id");

ALTER TABLE "supplier_payments" ADD COLUMN "sales_order_id" UUID;
UPDATE "supplier_payments" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "supplier_payments_sales_order_id_idx" ON "supplier_payments"("sales_order_id");

ALTER TABLE "supplier_payment_allocations" ADD COLUMN "sales_order_id" UUID;
UPDATE "supplier_payment_allocations" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "supplier_payment_allocations_sales_order_id_idx" ON "supplier_payment_allocations"("sales_order_id");

ALTER TABLE "supplier_payable_reconciliations" ADD COLUMN "sales_order_id" UUID;
UPDATE "supplier_payable_reconciliations" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "supplier_payable_reconciliations_sales_order_id_idx" ON "supplier_payable_reconciliations"("sales_order_id");

ALTER TABLE "cash_flow_entries" ADD COLUMN "sales_order_id" UUID;
UPDATE "cash_flow_entries" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "cash_flow_entries_sales_order_id_idx" ON "cash_flow_entries"("sales_order_id");

ALTER TABLE "payroll_payable_entries" ADD COLUMN "sales_order_id" UUID;
UPDATE "payroll_payable_entries" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
ALTER TABLE "payroll_payable_entries" ADD CONSTRAINT "payroll_payable_entries_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payroll_payable_entries_sales_order_id_idx" ON "payroll_payable_entries"("sales_order_id");

