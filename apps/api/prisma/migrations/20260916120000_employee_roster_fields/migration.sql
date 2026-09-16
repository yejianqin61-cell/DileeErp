-- 员工花名册口径（人事新模板：迪礼员工更新员工花名册）。
--
-- 背景：人事导入模板从「工号/姓名/部门编码/岗位编码/员工类型/入职日期/离职日期/备注」
-- 换成《在职员工花名册》的字段口径，员工档案需要承载身份、学历、社保与合同信息。
--
-- 全部可空：历史员工没有这些信息，新建/导入时也允许先留空后补录，
-- 因此本迁移只做加列，不改写任何既有行。
--
-- 不落库的派生列（年龄、工龄、当月生日员工、合同即将到期人员、劳务合同即将到期人员）
-- 由后端按 birth_date / hired_on / contract_end / labor_contract_end 实时计算，见
-- apps/api/src/modules/production/employee-roster.ts。

ALTER TABLE "employees" ADD COLUMN "birth_date" DATE;
ALTER TABLE "employees" ADD COLUMN "gender" VARCHAR(10);
ALTER TABLE "employees" ADD COLUMN "ethnicity" VARCHAR(50);
ALTER TABLE "employees" ADD COLUMN "id_card_no" VARCHAR(30);
ALTER TABLE "employees" ADD COLUMN "education" VARCHAR(50);
ALTER TABLE "employees" ADD COLUMN "blood_type" VARCHAR(10);
ALTER TABLE "employees" ADD COLUMN "social_insurance" BOOLEAN;
ALTER TABLE "employees" ADD COLUMN "commercial_insurance" BOOLEAN;
ALTER TABLE "employees" ADD COLUMN "contract_start" DATE;
ALTER TABLE "employees" ADD COLUMN "contract_end" DATE;
ALTER TABLE "employees" ADD COLUMN "labor_contract_start" DATE;
ALTER TABLE "employees" ADD COLUMN "labor_contract_end" DATE;
ALTER TABLE "employees" ADD COLUMN "home_address" VARCHAR(500);
ALTER TABLE "employees" ADD COLUMN "current_address" VARCHAR(500);
ALTER TABLE "employees" ADD COLUMN "phone" VARCHAR(50);
ALTER TABLE "employees" ADD COLUMN "emergency_contact" VARCHAR(100);
ALTER TABLE "employees" ADD COLUMN "emergency_phone" VARCHAR(50);

-- 身份证号按员工检索（导入去重提示、人事台账查询），不加唯一约束：
-- 历史花名册里存在空值与人工占位值，唯一约束会把整批导入直接顶掉。
CREATE INDEX "employees_id_card_no_idx" ON "employees"("id_card_no");

-- 与 employees_employee_type_check / employees_employment_status_check 同一套边界检查约定：
-- 性别只允许花名册口径的「男/女」，留空合法。
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_gender_check"
  CHECK ("gender" IS NULL OR "gender" IN ('男', '女'));

-- 合同区间必须单调，否则「合同即将到期」的派生提醒会算出无意义的结果。
ALTER TABLE "employees"
  ADD CONSTRAINT "employees_contract_range_check"
  CHECK ("contract_start" IS NULL OR "contract_end" IS NULL OR "contract_start" <= "contract_end");

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_labor_contract_range_check"
  CHECK ("labor_contract_start" IS NULL OR "labor_contract_end" IS NULL OR "labor_contract_start" <= "labor_contract_end");
