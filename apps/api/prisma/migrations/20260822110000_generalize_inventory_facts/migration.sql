ALTER TABLE "inventory_facts" DROP CONSTRAINT "inventory_facts_raw_material_inbound_id_fkey";

UPDATE "raw_material_inbounds" AS inbound
SET "unit_id" = item."unit_id"
FROM "purchase_order_items" AS item
WHERE inbound."purchase_order_item_id" = item."id"
  AND inbound."unit_id" IS NULL;

ALTER TABLE "inventory_facts"
  ALTER COLUMN "raw_material_inbound_id" DROP NOT NULL,
  ADD COLUMN "source_type" VARCHAR(50),
  ADD COLUMN "source_id" UUID,
  ADD COLUMN "source_version" VARCHAR(50),
  ADD COLUMN "order_no" VARCHAR(100),
  ADD COLUMN "production_order_id" UUID,
  ADD COLUMN "raw_material_movement_line_id" UUID;

UPDATE "inventory_facts" AS fact
SET
  "unit_id" = inbound."unit_id",
  "source_type" = 'raw_material_inbound',
  "source_id" = fact."raw_material_inbound_id",
  "order_no" = inbound."order_no"
FROM "raw_material_inbounds" AS inbound
WHERE fact."raw_material_inbound_id" = inbound."id";

ALTER TABLE "raw_material_inbounds"
  ALTER COLUMN "unit_id" SET NOT NULL;

ALTER TABLE "inventory_facts"
  ALTER COLUMN "unit_id" SET NOT NULL,
  ADD CONSTRAINT "inventory_facts_raw_material_inbound_id_fkey"
  FOREIGN KEY ("raw_material_inbound_id") REFERENCES "raw_material_inbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_facts_production_order_id_fkey"
  FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "inventory_facts_material_id_inventory_category_idx";
CREATE INDEX "inventory_facts_material_id_inventory_category_unit_id_idx" ON "inventory_facts"("material_id", "inventory_category", "unit_id");
CREATE INDEX "inventory_facts_source_type_source_id_idx" ON "inventory_facts"("source_type", "source_id");
CREATE INDEX "inventory_facts_order_no_idx" ON "inventory_facts"("order_no");
CREATE INDEX "inventory_facts_production_order_id_idx" ON "inventory_facts"("production_order_id");
