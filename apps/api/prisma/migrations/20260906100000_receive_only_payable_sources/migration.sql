-- Payables are generated only from posted raw-material inbound facts.
-- Historical receipt-level sources are no longer valid financial obligations.
UPDATE "payable_sources"
SET "status" = 'voided',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "raw_material_inbound_id" IS NULL
  AND "status" <> 'voided';

DROP INDEX IF EXISTS "payable_sources_purchase_receipt_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "payable_sources_raw_material_inbound_id_key"
  ON "payable_sources" ("raw_material_inbound_id");

ALTER TABLE "raw_material_inbounds"
  ADD COLUMN IF NOT EXISTS "settlement_unit_price" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "settlement_total_amount" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "settlement_amount_reason" VARCHAR(1000);

ALTER TABLE "incoming_inspections"
  ADD COLUMN IF NOT EXISTS "qc_result" VARCHAR(30);
