-- Keep the raw-material chain closed even when a write bypasses the HTTP services.
ALTER TABLE materials
  ADD CONSTRAINT materials_material_type_check
  CHECK (material_type IN ('raw_material', 'finished_product'));

ALTER TABLE raw_material_inbounds
  ADD CONSTRAINT raw_material_inbounds_inventory_category_check
  CHECK (inventory_category = 'raw_material');
