ALTER TABLE "bom_items" ADD COLUMN "specification_model" VARCHAR(200);
ALTER TABLE "bom_items" ADD COLUMN "production_batch_base" DECIMAL(18,4);
ALTER TABLE "bom_items" ADD COLUMN "base_usage" DECIMAL(18,4);
ALTER TABLE "bom_items" ADD COLUMN "approved_usage" DECIMAL(18,4);

UPDATE "bom_items"
SET "specification_model" = "model",
    "production_batch_base" = 1,
    "base_usage" = "required_quantity",
    "approved_usage" = "required_quantity"
WHERE "approved_usage" IS NULL;
