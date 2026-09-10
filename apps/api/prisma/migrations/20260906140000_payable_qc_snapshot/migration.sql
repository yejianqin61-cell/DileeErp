ALTER TABLE "payable_sources"
  ADD COLUMN IF NOT EXISTS "qc_result" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "accepted_quantity" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "conditional_quantity" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "rejected_quantity" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "actual_inbound_quantity" DECIMAL(18,4);
