CREATE TABLE "payroll_payable_entries" (
    "id" UUID NOT NULL,
    "payable_no" VARCHAR(100) NOT NULL,
    "ledger_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "order_no" VARCHAR(100),
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "source_snapshot" JSONB NOT NULL,
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "payroll_payable_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payroll_payable_entries_payable_no_key" ON "payroll_payable_entries"("payable_no");
CREATE UNIQUE INDEX "payroll_payable_entries_ledger_id_key" ON "payroll_payable_entries"("ledger_id");
CREATE INDEX "payroll_payable_entries_employee_id_status_idx" ON "payroll_payable_entries"("employee_id", "status");
CREATE INDEX "payroll_payable_entries_order_no_status_idx" ON "payroll_payable_entries"("order_no", "status");

ALTER TABLE "payroll_payable_entries"
  ADD CONSTRAINT "payroll_payable_entries_ledger_id_fkey"
  FOREIGN KEY ("ledger_id") REFERENCES "payroll_ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payroll_payable_entries"
  ADD CONSTRAINT "payroll_payable_entries_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
