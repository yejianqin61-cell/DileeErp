CREATE TABLE "raw_material_inbound_notices" (
  "id" UUID NOT NULL,
  "notice_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "purchase_order_id" UUID NOT NULL,
  "purchase_order_item_id" UUID NOT NULL,
  "purchase_receipt_id" UUID NOT NULL,
  "incoming_inspection_id" UUID NOT NULL,
  "material_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "notified_quantity" DECIMAL(18,4) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "notified_by" UUID NOT NULL,
  "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "received_by" UUID,
  "received_at" TIMESTAMP(3),
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "raw_material_inbound_notices_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "raw_material_inbounds" ADD COLUMN "inbound_notice_id" UUID;

CREATE UNIQUE INDEX "raw_material_inbound_notices_notice_no_key" ON "raw_material_inbound_notices"("notice_no");
CREATE UNIQUE INDEX "raw_material_inbound_notices_purchase_receipt_id_key" ON "raw_material_inbound_notices"("purchase_receipt_id") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "raw_material_inbound_notices_incoming_inspection_id_key" ON "raw_material_inbound_notices"("incoming_inspection_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "raw_material_inbound_notices_order_no_status_idx" ON "raw_material_inbound_notices"("order_no", "status");
CREATE INDEX "raw_material_inbound_notices_purchase_order_id_status_idx" ON "raw_material_inbound_notices"("purchase_order_id", "status");
CREATE INDEX "raw_material_inbounds_inbound_notice_id_idx" ON "raw_material_inbounds"("inbound_notice_id");

ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_incoming_inspection_id_fkey" FOREIGN KEY ("incoming_inspection_id") REFERENCES "incoming_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_inbound_notice_id_fkey" FOREIGN KEY ("inbound_notice_id") REFERENCES "raw_material_inbound_notices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
