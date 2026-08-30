CREATE TABLE "supplier_payable_reconciliations" (
  "id" UUID NOT NULL,
  "reconciliation_no" VARCHAR(100) NOT NULL,
  "order_no" VARCHAR(100),
  "purchase_order_id" UUID,
  "supplier_id" UUID NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "payable_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "payment_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "adjustment_amount_snapshot" DECIMAL(18,4) NOT NULL,
  "system_balance" DECIMAL(18,4) NOT NULL,
  "external_balance" DECIMAL(18,4) NOT NULL,
  "difference" DECIMAL(18,4) NOT NULL,
  "currency" VARCHAR(10) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "resolution_remark" VARCHAR(1000),
  "attachment" JSONB NOT NULL DEFAULT '[]',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "supplier_payable_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_payable_reconciliations_reconciliation_no_key" ON "supplier_payable_reconciliations"("reconciliation_no");
CREATE INDEX "supplier_payable_reconciliations_supplier_id_status_idx" ON "supplier_payable_reconciliations"("supplier_id", "status");
CREATE INDEX "supplier_payable_reconciliations_order_no_status_idx" ON "supplier_payable_reconciliations"("order_no", "status");
CREATE INDEX "supplier_payable_reconciliations_period_start_period_end_idx" ON "supplier_payable_reconciliations"("period_start", "period_end");
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
