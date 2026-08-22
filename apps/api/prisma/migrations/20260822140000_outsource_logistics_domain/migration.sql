CREATE TABLE "outsource_logistics_batches" (
  "id" UUID NOT NULL, "batch_no" VARCHAR(100) NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL, "outsource_location_id" UUID NOT NULL,
  "purchase_order_id" UUID NOT NULL, "purchase_order_item_id" UUID NOT NULL,
  "material_id" UUID NOT NULL, "unit_id" UUID NOT NULL,
  "planned_quantity" DECIMAL(18,4) NOT NULL, "dispatched_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft', "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "outsource_logistics_batches_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "outsource_receipts" (
  "id" UUID NOT NULL, "logistics_batch_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "receipt_date" DATE NOT NULL, "quantity" DECIMAL(18,4) NOT NULL, "receiver_name" VARCHAR(100),
  "proof_remark" VARCHAR(1000), "status" VARCHAR(30) NOT NULL DEFAULT 'received',
  "reversal_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0, "reversal_reason" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "outsource_receipts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "outsource_return_transfers" (
  "id" UUID NOT NULL, "transfer_no" VARCHAR(100) NOT NULL, "transfer_type" VARCHAR(40) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL, "production_order_id" UUID NOT NULL, "logistics_batch_id" UUID,
  "material_id" UUID, "unit_id" UUID NOT NULL, "product_description" VARCHAR(500),
  "quantity" DECIMAL(18,4) NOT NULL, "transfer_date" DATE NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "remark" VARCHAR(1000), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "outsource_return_transfers_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "outsource_direct_shipments" (
  "id" UUID NOT NULL, "shipment_no" VARCHAR(100) NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL, "product_description" VARCHAR(500) NOT NULL, "unit_id" UUID NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL, "shipment_date" DATE NOT NULL, "logistics_reference" VARCHAR(500),
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft', "reversal_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "reversal_reason" VARCHAR(1000), "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "outsource_direct_shipments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outsource_logistics_batches_batch_no_key" ON "outsource_logistics_batches"("batch_no");
CREATE INDEX "outsource_logistics_batches_order_no_status_idx" ON "outsource_logistics_batches"("order_no", "status");
CREATE INDEX "outsource_logistics_batches_production_order_id_status_idx" ON "outsource_logistics_batches"("production_order_id", "status");
CREATE INDEX "outsource_logistics_batches_purchase_order_item_id_status_idx" ON "outsource_logistics_batches"("purchase_order_item_id", "status");
CREATE INDEX "outsource_receipts_logistics_batch_id_receipt_date_idx" ON "outsource_receipts"("logistics_batch_id", "receipt_date");
CREATE INDEX "outsource_receipts_order_no_receipt_date_idx" ON "outsource_receipts"("order_no", "receipt_date");
CREATE UNIQUE INDEX "outsource_return_transfers_transfer_no_key" ON "outsource_return_transfers"("transfer_no");
CREATE INDEX "outsource_return_transfers_order_no_transfer_type_status_idx" ON "outsource_return_transfers"("order_no", "transfer_type", "status");
CREATE INDEX "outsource_return_transfers_production_order_id_status_idx" ON "outsource_return_transfers"("production_order_id", "status");
CREATE UNIQUE INDEX "outsource_direct_shipments_shipment_no_key" ON "outsource_direct_shipments"("shipment_no");
CREATE INDEX "outsource_direct_shipments_order_no_status_idx" ON "outsource_direct_shipments"("order_no", "status");
CREATE INDEX "outsource_direct_shipments_production_order_id_status_idx" ON "outsource_direct_shipments"("production_order_id", "status");

ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_outsource_location_id_fkey" FOREIGN KEY ("outsource_location_id") REFERENCES "production_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_receipts" ADD CONSTRAINT "outsource_receipts_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_direct_shipments" ADD CONSTRAINT "outsource_direct_shipments_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_direct_shipments" ADD CONSTRAINT "outsource_direct_shipments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
