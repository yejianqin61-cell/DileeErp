ALTER TABLE "outsource_logistics_batches"
  ADD COLUMN "dispatch_date" DATE,
  ADD COLUMN "dispatch_proof_remark" VARCHAR(1000);
ALTER TABLE "outsource_receipts"
  ADD COLUMN "difference_reason" VARCHAR(1000),
  ADD COLUMN "idempotency_key" VARCHAR(200) NOT NULL;
CREATE UNIQUE INDEX "outsource_receipts_idempotency_key_key" ON "outsource_receipts"("idempotency_key");

CREATE TABLE "outsource_payable_sources" (
  "id" UUID NOT NULL, "outsource_receipt_id" UUID NOT NULL, "logistics_batch_id" UUID NOT NULL,
  "order_no" VARCHAR(100) NOT NULL, "purchase_order_id" UUID NOT NULL, "purchase_order_item_id" UUID NOT NULL,
  "supplier_id" UUID NOT NULL, "quantity" DECIMAL(18,4) NOT NULL, "unit_price" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL, "tax_rate" DECIMAL(8,4), "amount" DECIMAL(18,4) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending_finance',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "outsource_payable_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outsource_payable_sources_outsource_receipt_id_key" ON "outsource_payable_sources"("outsource_receipt_id");
CREATE INDEX "outsource_payable_sources_order_no_status_idx" ON "outsource_payable_sources"("order_no", "status");
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_outsource_receipt_id_fkey" FOREIGN KEY ("outsource_receipt_id") REFERENCES "outsource_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
