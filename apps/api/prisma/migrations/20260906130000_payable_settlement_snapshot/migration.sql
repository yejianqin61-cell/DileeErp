ALTER TABLE "payable_sources"
  ADD COLUMN IF NOT EXISTS "material_id" UUID,
  ADD COLUMN IF NOT EXISTS "settlement_unit_price" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "settlement_total_amount" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "settlement_amount_reason" VARCHAR(1000);
