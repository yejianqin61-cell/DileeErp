CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL, "purchase_order_no" VARCHAR(100) NOT NULL, "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL, "bom_id" UUID NOT NULL, "bom_version" INTEGER NOT NULL, "bom_snapshot" JSONB NOT NULL,
    "supplier_id" UUID NOT NULL, "supplier_snapshot" JSONB NOT NULL, "purchase_date" TIMESTAMP(3) NOT NULL,
    "expected_date" TIMESTAMP(3), "currency" VARCHAR(10) NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0, "extension_data" JSONB NOT NULL DEFAULT '{}', "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL, "purchase_order_id" UUID NOT NULL, "material_id" UUID NOT NULL, "material_snapshot" JSONB NOT NULL,
    "unit_id" UUID NOT NULL, "unit_snapshot" JSONB NOT NULL, "bom_item_id" UUID, "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL, "tax_rate" DECIMAL(8,4), "extra_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,4) NOT NULL, "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "purchase_receipts" (
    "id" UUID NOT NULL, "purchase_order_id" UUID NOT NULL, "purchase_order_item_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL,
    "receipt_no" VARCHAR(100) NOT NULL, "reference_no" VARCHAR(100), "received_date" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL, "status" VARCHAR(30) NOT NULL DEFAULT 'received', "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "purchase_orders_purchase_order_no_key" ON "purchase_orders"("purchase_order_no");
CREATE UNIQUE INDEX "purchase_receipts_receipt_no_key" ON "purchase_receipts"("receipt_no");
CREATE INDEX "purchase_orders_order_no_status_idx" ON "purchase_orders"("order_no", "status");
CREATE INDEX "purchase_orders_supplier_id_status_idx" ON "purchase_orders"("supplier_id", "status");
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id");
CREATE INDEX "purchase_receipts_purchase_order_item_id_received_date_idx" ON "purchase_receipts"("purchase_order_item_id", "received_date");
CREATE INDEX "purchase_receipts_order_no_idx" ON "purchase_receipts"("order_no");
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
