ALTER TABLE "bom_items" ADD COLUMN "material_name" VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE "bom_items" ADD COLUMN "model" VARCHAR(200);
ALTER TABLE "bom_items" ADD COLUMN "color" VARCHAR(100);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "boms"
    GROUP BY "sales_order_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one BOM per sales order while duplicate BOM records exist. Resolve the duplicate BOMs before applying this migration.';
  END IF;
END $$;

DROP INDEX IF EXISTS "boms_sales_order_id_version_key";
CREATE UNIQUE INDEX "boms_sales_order_id_key" ON "boms"("sales_order_id");
