ALTER TABLE "salary_payment_allocations"
  ADD COLUMN IF NOT EXISTS "payroll_payable_id" UUID;

CREATE INDEX IF NOT EXISTS "salary_payment_allocations_payroll_payable_id_status_idx"
  ON "salary_payment_allocations"("payroll_payable_id", "status");

ALTER TABLE "salary_payment_allocations"
  ADD CONSTRAINT "salary_payment_allocations_payroll_payable_id_fkey"
  FOREIGN KEY ("payroll_payable_id") REFERENCES "payroll_payable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
