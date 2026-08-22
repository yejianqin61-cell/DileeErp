ALTER TABLE "inventory_facts"
  ALTER COLUMN "material_id" DROP NOT NULL,
  ADD COLUMN "product_name_snapshot" VARCHAR(200),
  ADD COLUMN "product_specification_snapshot" VARCHAR(1000),
  ADD COLUMN "finished_goods_inbound_id" UUID,
  ADD COLUMN "finished_goods_defective_id" UUID;

CREATE TABLE "finished_goods_inbounds" (
  "id" UUID NOT NULL,
  "inbound_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL,
  "qc_record_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "product_name_snapshot" VARCHAR(200),
  "product_specification_snapshot" VARCHAR(1000),
  "quantity" DECIMAL(18,4) NOT NULL,
  "inventory_category" VARCHAR(30) NOT NULL DEFAULT 'finished_goods',
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "idempotency_key" VARCHAR(200) NOT NULL,
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "finished_goods_inbounds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "finished_goods_defectives" (
  "id" UUID NOT NULL,
  "defective_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL,
  "qc_record_id" UUID NOT NULL,
  "submission_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "product_name_snapshot" VARCHAR(200),
  "product_specification_snapshot" VARCHAR(1000),
  "quantity" DECIMAL(18,4) NOT NULL,
  "inventory_category" VARCHAR(30) NOT NULL DEFAULT 'defective_goods',
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "disposition" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "idempotency_key" VARCHAR(200) NOT NULL,
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "finished_goods_defectives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finished_goods_inbounds_inbound_no_key" ON "finished_goods_inbounds"("inbound_no");
CREATE UNIQUE INDEX "finished_goods_inbounds_idempotency_key_key" ON "finished_goods_inbounds"("idempotency_key");
CREATE INDEX "finished_goods_inbounds_order_no_status_idx" ON "finished_goods_inbounds"("order_no", "status");
CREATE INDEX "finished_goods_inbounds_qc_record_id_status_idx" ON "finished_goods_inbounds"("qc_record_id", "status");
CREATE INDEX "finished_goods_inbounds_production_order_id_status_idx" ON "finished_goods_inbounds"("production_order_id", "status");
CREATE UNIQUE INDEX "finished_goods_defectives_defective_no_key" ON "finished_goods_defectives"("defective_no");
CREATE UNIQUE INDEX "finished_goods_defectives_idempotency_key_key" ON "finished_goods_defectives"("idempotency_key");
CREATE INDEX "finished_goods_defectives_order_no_status_idx" ON "finished_goods_defectives"("order_no", "status");
CREATE INDEX "finished_goods_defectives_qc_record_id_status_idx" ON "finished_goods_defectives"("qc_record_id", "status");
CREATE INDEX "finished_goods_defectives_production_order_id_status_idx" ON "finished_goods_defectives"("production_order_id", "status");
CREATE INDEX "inventory_facts_finished_goods_inbound_id_idx" ON "inventory_facts"("finished_goods_inbound_id");
CREATE INDEX "inventory_facts_finished_goods_defective_id_idx" ON "inventory_facts"("finished_goods_defective_id");

ALTER TABLE "finished_goods_inbounds"
  ADD CONSTRAINT "finished_goods_inbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_inbounds_qc_record_id_fkey" FOREIGN KEY ("qc_record_id") REFERENCES "finished_goods_qc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_inbounds_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_inbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finished_goods_defectives"
  ADD CONSTRAINT "finished_goods_defectives_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_defectives_qc_record_id_fkey" FOREIGN KEY ("qc_record_id") REFERENCES "finished_goods_qc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_defectives_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "finished_goods_defectives_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_facts"
  ADD CONSTRAINT "inventory_facts_finished_goods_inbound_id_fkey" FOREIGN KEY ("finished_goods_inbound_id") REFERENCES "finished_goods_inbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_facts_finished_goods_defective_id_fkey" FOREIGN KEY ("finished_goods_defective_id") REFERENCES "finished_goods_defectives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
