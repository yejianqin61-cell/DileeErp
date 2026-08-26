ALTER TABLE "attendance_records" ADD COLUMN "work_start_time" VARCHAR(5);
ALTER TABLE "attendance_records" ADD COLUMN "work_end_time" VARCHAR(5);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "attendance_records"
    WHERE "deleted_at" IS NULL
    GROUP BY "employee_id", "attendance_date"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one attendance summary per employee and date while duplicate records exist.';
  END IF;
END $$;

DROP INDEX IF EXISTS "attendance_records_employee_id_attendance_date_attendance_type_key";
CREATE UNIQUE INDEX "attendance_records_employee_id_attendance_date_key" ON "attendance_records"("employee_id", "attendance_date");
