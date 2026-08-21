CREATE TABLE "operation_daily_reports" (
  "id" UUID NOT NULL, "production_order_id" UUID NOT NULL, "production_order_operation_id" UUID NOT NULL,
  "order_no" VARCHAR(100) NOT NULL, "production_order_no_snapshot" VARCHAR(100) NOT NULL,
  "operation_name_snapshot" VARCHAR(150) NOT NULL, "unit_id" UUID NOT NULL, "report_date" DATE NOT NULL,
  "completed_quantity" DECIMAL(18,4) NOT NULL, "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "operation_daily_reports_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "employee_daily_reports" (
  "id" UUID NOT NULL, "production_order_id" UUID NOT NULL, "production_order_operation_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL, "production_order_no_snapshot" VARCHAR(100) NOT NULL,
  "operation_name_snapshot" VARCHAR(150) NOT NULL, "employee_name_snapshot" VARCHAR(100) NOT NULL,
  "report_date" DATE NOT NULL, "wage_mode" VARCHAR(20) NOT NULL, "quantity" DECIMAL(18,4) NOT NULL,
  "duration_minutes" DECIMAL(18,4), "unit_price" DECIMAL(18,4) NOT NULL, "calculated_amount" DECIMAL(18,4) NOT NULL,
  "price_override_reason" VARCHAR(1000), "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "employee_daily_reports_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "production_daily_alerts" (
  "id" UUID NOT NULL, "alert_type" VARCHAR(40) NOT NULL, "production_order_id" UUID NOT NULL,
  "production_order_operation_id" UUID NOT NULL, "order_no" VARCHAR(100) NOT NULL, "report_date" DATE NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending', "target_quantity" DECIMAL(18,4),
  "operation_report_quantity" DECIMAL(18,4), "employee_report_quantity" DECIMAL(18,4),
  "discrepancy_quantity" DECIMAL(18,4), "cumulative_quantity" DECIMAL(18,4), "over_order_quantity" DECIMAL(18,4),
  "confirm_remark" VARCHAR(1000), "confirmed_by" UUID, "confirmed_at" TIMESTAMP(3), "recovered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "production_daily_alerts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "production_payroll_sources" (
  "id" UUID NOT NULL, "employee_id" UUID NOT NULL, "production_order_id" UUID, "order_no" VARCHAR(100),
  "period_start" DATE NOT NULL, "period_end" DATE NOT NULL, "wage_mode" VARCHAR(20) NOT NULL,
  "quantity" DECIMAL(18,4) NOT NULL, "duration_minutes" DECIMAL(18,4) NOT NULL, "amount" DECIMAL(18,4) NOT NULL,
  "source_snapshot" JSONB NOT NULL, "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL, "updated_by" UUID NOT NULL, "deleted_at" TIMESTAMP(3), "deleted_by" UUID,
  CONSTRAINT "production_payroll_sources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "operation_daily_reports_production_order_id_report_date_idx" ON "operation_daily_reports"("production_order_id", "report_date");
CREATE INDEX "operation_daily_reports_production_order_operation_id_report_date_idx" ON "operation_daily_reports"("production_order_operation_id", "report_date");
CREATE INDEX "operation_daily_reports_order_no_report_date_idx" ON "operation_daily_reports"("order_no", "report_date");
CREATE INDEX "employee_daily_reports_production_order_id_report_date_idx" ON "employee_daily_reports"("production_order_id", "report_date");
CREATE INDEX "employee_daily_reports_production_order_operation_id_report_date_idx" ON "employee_daily_reports"("production_order_operation_id", "report_date");
CREATE INDEX "employee_daily_reports_employee_id_report_date_idx" ON "employee_daily_reports"("employee_id", "report_date");
CREATE INDEX "employee_daily_reports_order_no_report_date_idx" ON "employee_daily_reports"("order_no", "report_date");
CREATE UNIQUE INDEX "production_daily_alerts_production_order_operation_id_report_date_alert_type_key" ON "production_daily_alerts"("production_order_operation_id", "report_date", "alert_type");
CREATE INDEX "production_daily_alerts_production_order_id_status_idx" ON "production_daily_alerts"("production_order_id", "status");
CREATE INDEX "production_daily_alerts_order_no_report_date_idx" ON "production_daily_alerts"("order_no", "report_date");
CREATE UNIQUE INDEX "production_payroll_sources_employee_id_production_order_id_period_start_period_end_wage_mode_key" ON "production_payroll_sources"("employee_id", "production_order_id", "period_start", "period_end", "wage_mode");
CREATE INDEX "production_payroll_sources_employee_id_period_start_period_end_idx" ON "production_payroll_sources"("employee_id", "period_start", "period_end");
CREATE INDEX "production_payroll_sources_order_no_period_start_period_end_idx" ON "production_payroll_sources"("order_no", "period_start", "period_end");
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_daily_alerts" ADD CONSTRAINT "production_daily_alerts_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_daily_alerts" ADD CONSTRAINT "production_daily_alerts_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_payroll_sources" ADD CONSTRAINT "production_payroll_sources_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "production_payroll_sources" ADD CONSTRAINT "production_payroll_sources_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
