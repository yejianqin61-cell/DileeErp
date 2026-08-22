ALTER TABLE "outsource_return_transfers"
  ADD COLUMN "finished_goods_qc_status" VARCHAR(30) NOT NULL DEFAULT 'not_submitted';
CREATE INDEX "outsource_return_transfers_finished_goods_qc_status_idx" ON "outsource_return_transfers"("finished_goods_qc_status");
