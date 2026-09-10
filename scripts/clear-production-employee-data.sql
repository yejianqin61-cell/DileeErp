BEGIN;

-- Employee-dependent business facts. Keep User, Department, Position,
-- OperationCatalog, ProductionLocation, Unit, and all dictionary rows.

DELETE FROM "salary_payment_allocations";
DELETE FROM "payroll_adjustments";
DELETE FROM "salary_payments";
DELETE FROM "payroll_ledgers";
DELETE FROM "production_payroll_sources";
DELETE FROM "employee_daily_reports";
DELETE FROM "attendance_records";
DELETE FROM "performance_records";
DELETE FROM "operation_rates";
DELETE FROM "daily_report_merge_anomalies" WHERE "employee_id" IS NOT NULL;
DELETE FROM "employees";

COMMIT;
