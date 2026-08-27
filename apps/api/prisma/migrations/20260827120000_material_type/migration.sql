ALTER TABLE "materials" ADD COLUMN "material_type" VARCHAR(30) NOT NULL DEFAULT 'raw_material';
CREATE INDEX "materials_material_type_idx" ON "materials"("material_type");
