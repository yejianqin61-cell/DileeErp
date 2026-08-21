CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "materials" (
    "id" UUID NOT NULL,
    "material_code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "default_unit_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "supplier_code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(100),
    "phone" VARCHAR(50),
    "settlement_info" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "units_name_key" ON "units"("name");
CREATE UNIQUE INDEX "materials_material_code_key" ON "materials"("material_code");
CREATE UNIQUE INDEX "materials_name_key" ON "materials"("name");
CREATE UNIQUE INDEX "suppliers_supplier_code_key" ON "suppliers"("supplier_code");
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");
CREATE INDEX "materials_default_unit_id_idx" ON "materials"("default_unit_id");
ALTER TABLE "materials" ADD CONSTRAINT "materials_default_unit_id_fkey" FOREIGN KEY ("default_unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bom_items" ADD COLUMN "unit_id" UUID;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
