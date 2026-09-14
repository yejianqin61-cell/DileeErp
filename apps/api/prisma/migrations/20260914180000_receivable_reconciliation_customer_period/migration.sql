-- 应收对账改为「客户 + 期间」维度。
--
-- 原口径：对账必须挂在单个订单号上（order_no NOT NULL），一个客户有多张订单就要建多张对账单，
-- 与财务实际工作方式（按客户按月对账）不符。
-- 新口径：客户 + 期间为对账主键，订单号变成可选过滤条件。
--
-- 只放宽约束，不迁移/不改写任何历史行：已有对账单的 order_no 保持原值。
ALTER TABLE "receivable_reconciliations" ALTER COLUMN "order_no" DROP NOT NULL;
