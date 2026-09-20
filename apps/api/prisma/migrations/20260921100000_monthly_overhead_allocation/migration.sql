-- 月度管理费分摊登记（财务，用户 2026-09-20）
--
-- 依据：`example/财务/核算表.xlsx`（财务说「这个也要」）+ 财务口述的分摊口径：
-- 「我这里的管理费是一个月的所以费用的总合平摊在本月生产的总数量中。比如这个月管理费是22万，
--   生产了4000打货，管理费就是55元」。设计见
-- docs/design/finance-cost-accounting-and-voucher-editing-2026-09-20.md。
--
-- 三处刻意的取舍（都写在这里，避免后来的人以为是漏了）：
--   1. **单独建表而不是汇总「管理费用类科目」的收支流水**：财务的口径是先有总额再有费率，
--      总额必须是「财务确认过的这个月的管理费」；流水常常滞后（月底费用下月才报销），
--      直接汇总流水会让本月费率凭空偏低，而报表上看不出来。
--   2. **金额没有 currency 列**：管理费是内账人民币口径，核算表本身也是人民币（本币）口径的报表。
--   3. **unit 落库**：老核算表没有单位列，而「55 元/打」与「55 元/支」差 12 倍。全站纪律是
--      「不跨单位相加」，所以单位必须是登记的一部分，核算表只对单位一致的订单套费率。
--
-- `period` 唯一且**软删除后仍占着这个期间**：一个期间只该有一条管理费口径，两条并存就会有
-- 「用哪条算费率」的歧义；服务层按期间 upsert（含把已软删的那条恢复回来），所以唯一索引成立。
CREATE TABLE "overhead_allocations" (
    "id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "quantity_override" DECIMAL(18,4),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "overhead_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "overhead_allocations_period_key" ON "overhead_allocations"("period");
