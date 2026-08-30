ALTER TABLE "purchase_receipts"
  ADD COLUMN "extension_data" JSONB NOT NULL DEFAULT '{}'::jsonb;
