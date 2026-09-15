-- 2026-09-15 工资类目细化：房补 + 迟到/旷工/早退三种扣款。
--
-- 只做加法：老列（attendance_deduction「考勤扣款」、allowance_amount「补贴金额」）保持原语义，
-- 历史金额不被重新解释；新需求只挂新列。四列均 NOT NULL DEFAULT 0，既有行自动补 0，无需回填，
-- 也不会出现 NULL 参与应发求和。
ALTER TABLE "payroll_ledgers" ADD COLUMN "late_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_ledgers" ADD COLUMN "absence_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_ledgers" ADD COLUMN "early_leave_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "payroll_ledgers" ADD COLUMN "housing_allowance" DECIMAL(18,4) NOT NULL DEFAULT 0;
