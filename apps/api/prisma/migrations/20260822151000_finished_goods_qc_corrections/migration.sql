ALTER TABLE "finished_goods_qc_records"
  ADD COLUMN "status" VARCHAR(30) NOT NULL DEFAULT 'active',
  ADD COLUMN "correction_reason" VARCHAR(1000),
  ADD COLUMN "corrected_at" TIMESTAMP(3);
CREATE INDEX "finished_goods_qc_records_submission_id_status_idx" ON "finished_goods_qc_records"("submission_id", "status");
