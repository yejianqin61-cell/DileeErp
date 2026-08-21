CREATE TABLE "incoming_inspections" (
  "id" UUID NOT NULL, "purchase_receipt_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL,
  "inspected_quantity" DECIMAL(18,4) NOT NULL, "accepted_quantity" DECIMAL(18,4) NOT NULL,
  "conditional_quantity" DECIMAL(18,4) NOT NULL, "rejected_quantity" DECIMAL(18,4) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending', "extension_data" JSONB NOT NULL DEFAULT '{}', "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "incoming_inspections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "incoming_inspections_purchase_receipt_id_idx" ON "incoming_inspections"("purchase_receipt_id");
CREATE INDEX "incoming_inspections_order_no_idx" ON "incoming_inspections"("order_no");
ALTER TABLE "incoming_inspections" ADD CONSTRAINT "incoming_inspections_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
