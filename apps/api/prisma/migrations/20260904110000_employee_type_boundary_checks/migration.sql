ALTER TABLE "employees"
  ADD CONSTRAINT "employees_employee_type_check"
  CHECK ("employee_type" IN ('workshop', 'non_workshop'));
