ALTER TABLE "raw_material_inbounds" ADD COLUMN "unit_id" UUID;
ALTER TABLE "inventory_facts" ADD COLUMN "unit_id" UUID;

ALTER TABLE "raw_material_inbounds"
  ADD CONSTRAINT "raw_material_inbounds_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inventory_facts"
  ADD CONSTRAINT "inventory_facts_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
