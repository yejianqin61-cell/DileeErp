CREATE TABLE "finished_goods_inspection_submissions" (
  "id" UUID NOT NULL,
  "submission_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL,
  "source_type" VARCHAR(40) NOT NULL,
  "source_id" UUID NOT NULL,
  "production_order_no_snapshot" VARCHAR(100) NOT NULL,
  "product_name_snapshot" VARCHAR(200),
  "product_specification_snapshot" VARCHAR(1000),
  "unit_id" UUID NOT NULL,
  "unit_name_snapshot" VARCHAR(30) NOT NULL,
  "submitted_quantity" DECIMAL(18,4) NOT NULL,
  "submission_date" DATE NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "remark" VARCHAR(1000),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "finished_goods_inspection_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finished_goods_inspection_submissions_submission_no_key" ON "finished_goods_inspection_submissions"("submission_no");
CREATE INDEX "finished_goods_inspection_submissions_order_no_status_idx" ON "finished_goods_inspection_submissions"("order_no", "status");
CREATE INDEX "finished_goods_inspection_submissions_production_order_id_source_type_source_id_idx" ON "finished_goods_inspection_submissions"("production_order_id", "source_type", "source_id");
CREATE INDEX "finished_goods_inspection_submissions_source_type_source_id_status_idx" ON "finished_goods_inspection_submissions"("source_type", "source_id", "status");
ALTER TABLE "finished_goods_inspection_submissions" ADD CONSTRAINT "finished_goods_inspection_submissions_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finished_goods_inspection_submissions" ADD CONSTRAINT "finished_goods_inspection_submissions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "finished_goods_qc_records" (
  "id" UUID NOT NULL,
  "qc_no" VARCHAR(100) NOT NULL,
  "submission_id" UUID NOT NULL,
  "order_no" VARCHAR(100) NOT NULL,
  "production_order_id" UUID NOT NULL,
  "source_type" VARCHAR(40) NOT NULL,
  "source_id" UUID NOT NULL,
  "inspection_date" DATE NOT NULL,
  "inspected_quantity" DECIMAL(18,4) NOT NULL,
  "qualified_quantity" DECIMAL(18,4) NOT NULL,
  "conditional_accept_quantity" DECIMAL(18,4) NOT NULL,
  "rejected_quantity" DECIMAL(18,4) NOT NULL,
  "conclusion" VARCHAR(30) NOT NULL,
  "rejection_reason" VARCHAR(1000),
  "remark" VARCHAR(1000),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "finished_goods_qc_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "finished_goods_qc_records_qc_no_key" ON "finished_goods_qc_records"("qc_no");
CREATE INDEX "finished_goods_qc_records_order_no_conclusion_idx" ON "finished_goods_qc_records"("order_no", "conclusion");
CREATE INDEX "finished_goods_qc_records_submission_id_inspection_date_idx" ON "finished_goods_qc_records"("submission_id", "inspection_date");
CREATE INDEX "finished_goods_qc_records_production_order_id_source_type_source_id_idx" ON "finished_goods_qc_records"("production_order_id", "source_type", "source_id");
ALTER TABLE "finished_goods_qc_records" ADD CONSTRAINT "finished_goods_qc_records_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
