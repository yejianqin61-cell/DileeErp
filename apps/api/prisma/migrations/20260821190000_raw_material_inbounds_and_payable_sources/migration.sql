CREATE TABLE "raw_material_inbounds" (
  "id" UUID NOT NULL, "inbound_no" VARCHAR(100) NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "purchase_order_id" UUID NOT NULL, "purchase_order_item_id" UUID NOT NULL, "purchase_receipt_id" UUID NOT NULL,
  "incoming_inspection_id" UUID NOT NULL, "material_id" UUID NOT NULL, "supplier_id" UUID NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL, "inventory_category" VARCHAR(30) NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "idempotency_key" VARCHAR(200) NOT NULL, "remark" VARCHAR(1000), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "raw_material_inbounds_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "inventory_facts" (
  "id" UUID NOT NULL, "raw_material_inbound_id" UUID NOT NULL, "material_id" UUID NOT NULL,
  "inventory_category" VARCHAR(30) NOT NULL, "quantity_delta" DECIMAL(18,4) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by" UUID NOT NULL,
  CONSTRAINT "inventory_facts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "payable_sources" (
  "id" UUID NOT NULL, "raw_material_inbound_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "purchase_order_id" UUID NOT NULL, "purchase_order_item_id" UUID NOT NULL, "supplier_id" UUID NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL, "unit_price" DECIMAL(18,4) NOT NULL, "currency" VARCHAR(10) NOT NULL,
  "tax_rate" DECIMAL(8,4), "amount" DECIMAL(18,4) NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'pending_finance',
  "idempotency_key" VARCHAR(200) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL,
  CONSTRAINT "payable_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "raw_material_inbounds_inbound_no_key" ON "raw_material_inbounds"("inbound_no");
CREATE UNIQUE INDEX "raw_material_inbounds_idempotency_key_key" ON "raw_material_inbounds"("idempotency_key");
CREATE INDEX "raw_material_inbounds_order_no_idx" ON "raw_material_inbounds"("order_no");
CREATE INDEX "inventory_facts_material_id_inventory_category_idx" ON "inventory_facts"("material_id", "inventory_category");
CREATE UNIQUE INDEX "payable_sources_raw_material_inbound_id_key" ON "payable_sources"("raw_material_inbound_id");
CREATE UNIQUE INDEX "payable_sources_idempotency_key_key" ON "payable_sources"("idempotency_key");
CREATE INDEX "payable_sources_order_no_idx" ON "payable_sources"("order_no");
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_incoming_inspection_id_fkey" FOREIGN KEY ("incoming_inspection_id") REFERENCES "incoming_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_raw_material_inbound_id_fkey" FOREIGN KEY ("raw_material_inbound_id") REFERENCES "raw_material_inbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_raw_material_inbound_id_fkey" FOREIGN KEY ("raw_material_inbound_id") REFERENCES "raw_material_inbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
