CREATE TABLE "form_definitions" (
    "id" UUID NOT NULL,
    "form_key" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "form_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "form_fields" (
    "id" UUID NOT NULL,
    "form_definition_id" UUID NOT NULL,
    "field_key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "field_type" VARCHAR(30) NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bom_items" (
    "id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "material_snapshot" JSONB NOT NULL,
    "required_quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "loss_quantity" DECIMAL(18,4),
    "loss_rate" DECIMAL(8,4),
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "form_definitions_form_key_version_key" ON "form_definitions"("form_key", "version");
CREATE INDEX "form_definitions_form_key_status_idx" ON "form_definitions"("form_key", "status");
CREATE UNIQUE INDEX "form_fields_form_definition_id_field_key_key" ON "form_fields"("form_definition_id", "field_key");
CREATE INDEX "bom_items_bom_id_idx" ON "bom_items"("bom_id");
CREATE INDEX "bom_items_material_id_idx" ON "bom_items"("material_id");

ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_form_definition_id_fkey" FOREIGN KEY ("form_definition_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "boms" ADD COLUMN "form_definition_id" UUID;
ALTER TABLE "boms" ADD CONSTRAINT "boms_form_definition_id_fkey" FOREIGN KEY ("form_definition_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
