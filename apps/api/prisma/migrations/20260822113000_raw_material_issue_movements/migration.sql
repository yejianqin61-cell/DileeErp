CREATE TABLE "raw_material_movements" (
  "id" UUID NOT NULL, "movement_no" VARCHAR(100) NOT NULL, "document_type" VARCHAR(30) NOT NULL DEFAULT 'issue', "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "production_order_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL, "business_date" DATE NOT NULL, "reason" VARCHAR(1000), "remark" VARCHAR(1000), "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "raw_material_movements_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "raw_material_movement_lines" (
  "id" UUID NOT NULL, "movement_id" UUID NOT NULL, "material_id" UUID NOT NULL, "unit_id" UUID NOT NULL, "quantity" DECIMAL(18,4) NOT NULL, "bom_reference_quantity" DECIMAL(18,4), "source_issue_line_id" UUID, "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "raw_material_movement_lines_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "raw_material_movement_risks" (
  "id" UUID NOT NULL, "movement_id" UUID NOT NULL, "line_id" UUID, "risk_type" VARCHAR(50) NOT NULL, "context" JSONB NOT NULL DEFAULT '{}', "reason" VARCHAR(1000) NOT NULL, "confirmed_by" UUID NOT NULL, "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL, "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "raw_material_movement_risks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "raw_material_movements_movement_no_key" ON "raw_material_movements"("movement_no");
CREATE UNIQUE INDEX "raw_material_movements_idempotency_key_key" ON "raw_material_movements"("idempotency_key");
CREATE INDEX "raw_material_movements_production_order_id_status_idx" ON "raw_material_movements"("production_order_id", "status");
CREATE INDEX "raw_material_movements_order_no_business_date_idx" ON "raw_material_movements"("order_no", "business_date");
CREATE INDEX "raw_material_movement_lines_movement_id_idx" ON "raw_material_movement_lines"("movement_id");
CREATE INDEX "raw_material_movement_lines_material_id_unit_id_idx" ON "raw_material_movement_lines"("material_id", "unit_id");
CREATE INDEX "raw_material_movement_risks_movement_id_risk_type_idx" ON "raw_material_movement_risks"("movement_id", "risk_type");
ALTER TABLE "raw_material_movements" ADD CONSTRAINT "raw_material_movements_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "raw_material_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_source_issue_line_id_fkey" FOREIGN KEY ("source_issue_line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_risks" ADD CONSTRAINT "raw_material_movement_risks_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "raw_material_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "raw_material_movement_risks" ADD CONSTRAINT "raw_material_movement_risks_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_raw_material_movement_line_id_fkey" FOREIGN KEY ("raw_material_movement_line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
