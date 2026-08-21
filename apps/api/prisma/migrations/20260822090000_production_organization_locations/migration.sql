CREATE TABLE "departments" (
  "id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "positions" (
  "id" UUID NOT NULL,
  "department_id" UUID NOT NULL,
  "code" VARCHAR(80) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "employees" (
  "id" UUID NOT NULL,
  "employee_no" VARCHAR(80) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "department_id" UUID NOT NULL,
  "position_id" UUID NOT NULL,
  "employee_type" VARCHAR(40) NOT NULL,
  "employment_status" VARCHAR(30) NOT NULL DEFAULT 'active',
  "user_id" UUID,
  "hired_on" DATE,
  "left_on" DATE,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "production_locations" (
  "id" UUID NOT NULL,
  "name" VARCHAR(150) NOT NULL,
  "location_type" VARCHAR(30) NOT NULL,
  "contact_name" VARCHAR(100),
  "contact_phone" VARCHAR(50),
  "address" VARCHAR(500),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "remark" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "deleted_by" UUID,
  CONSTRAINT "production_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");
CREATE UNIQUE INDEX "positions_department_id_code_key" ON "positions"("department_id", "code");
CREATE INDEX "positions_department_id_is_active_idx" ON "positions"("department_id", "is_active");
CREATE UNIQUE INDEX "employees_employee_no_key" ON "employees"("employee_no");
CREATE INDEX "employees_department_id_employment_status_idx" ON "employees"("department_id", "employment_status");
CREATE INDEX "employees_position_id_employment_status_idx" ON "employees"("position_id", "employment_status");
CREATE UNIQUE INDEX "production_locations_name_location_type_key" ON "production_locations"("name", "location_type");
CREATE INDEX "production_locations_location_type_is_active_idx" ON "production_locations"("location_type", "is_active");
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
