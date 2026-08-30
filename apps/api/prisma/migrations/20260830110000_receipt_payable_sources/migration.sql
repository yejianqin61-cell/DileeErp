ALTER TABLE "payable_sources"
  ALTER COLUMN "raw_material_inbound_id" DROP NOT NULL;

ALTER TABLE "payable_sources"
  ADD COLUMN "purchase_receipt_id" UUID;

ALTER TABLE "payable_sources"
  ADD CONSTRAINT "payable_sources_purchase_receipt_id_fkey"
  FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "payable_sources_purchase_receipt_id_key" ON "payable_sources"("purchase_receipt_id");
