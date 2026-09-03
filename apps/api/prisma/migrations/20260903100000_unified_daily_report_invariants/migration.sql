-- Consolidate exact-key historical duplicates before adding database guards.
WITH ranked AS (
  SELECT id, production_order_operation_id, report_date,
         row_number() OVER (PARTITION BY production_order_operation_id, report_date ORDER BY created_at, id) AS rn,
         sum(completed_quantity) OVER (PARTITION BY production_order_operation_id, report_date) AS total_quantity
  FROM operation_daily_reports
  WHERE deleted_at IS NULL
), keepers AS (
  UPDATE operation_daily_reports r
  SET completed_quantity = ranked.total_quantity,
      updated_at = now()
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn = 1
  RETURNING r.id
)
UPDATE operation_daily_reports r
SET deleted_at = now(), updated_at = now()
WHERE r.id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE TABLE IF NOT EXISTS daily_report_merge_anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_kind varchar(30) NOT NULL,
  production_order_operation_id uuid NOT NULL,
  employee_id uuid,
  report_date date NOT NULL,
  wage_modes jsonb NOT NULL,
  report_ids jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

INSERT INTO daily_report_merge_anomalies (report_kind, production_order_operation_id, employee_id, report_date, wage_modes, report_ids)
SELECT 'employee', production_order_operation_id, employee_id, report_date,
       jsonb_agg(DISTINCT wage_mode ORDER BY wage_mode), jsonb_agg(id ORDER BY created_at, id)
FROM employee_daily_reports
WHERE deleted_at IS NULL
GROUP BY production_order_operation_id, employee_id, report_date
HAVING count(DISTINCT wage_mode) > 1;

WITH ranked AS (
  SELECT id, production_order_operation_id, employee_id, report_date, wage_mode,
         row_number() OVER (PARTITION BY production_order_operation_id, employee_id, report_date, wage_mode ORDER BY created_at, id) AS rn,
         sum(quantity) OVER (PARTITION BY production_order_operation_id, employee_id, report_date, wage_mode) AS total_quantity,
         sum(coalesce(duration_minutes, 0)) OVER (PARTITION BY production_order_operation_id, employee_id, report_date, wage_mode) AS total_duration,
         sum(calculated_amount) OVER (PARTITION BY production_order_operation_id, employee_id, report_date, wage_mode) AS total_amount
  FROM employee_daily_reports
  WHERE deleted_at IS NULL
), keepers AS (
  UPDATE employee_daily_reports r
  SET quantity = ranked.total_quantity,
      duration_minutes = ranked.total_duration,
      calculated_amount = ranked.total_amount,
      updated_at = now()
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn = 1
  RETURNING r.id
)
UPDATE employee_daily_reports r
SET deleted_at = now(), updated_at = now()
WHERE r.id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS operation_daily_reports_active_business_key
  ON operation_daily_reports (production_order_operation_id, report_date)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_daily_reports_active_business_key
  ON employee_daily_reports (production_order_operation_id, employee_id, report_date, wage_mode)
  WHERE deleted_at IS NULL;

