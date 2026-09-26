-- 建账期初余额（财务 2026-09-24：三大报表的起点）
--
-- 依据：用户 2026-09-24 回复「1,3,4 都要」里的第 ③ 件 —— 科目期初余额表。
-- 设计见 docs/design/finance-three-statements-2026-09-24.md §8.5。
--
-- 为什么必须建这张表：银行账户档案里只有**货币资金**的期初余额，其它科目没有。
-- 报表只能把货币资金期初加进资产侧，于是「资产总计 = 负债和所有者权益总计」永远差一个
-- 期初余额的差额（报表内核会把差额显式返回并写进表尾，但那是「说明」不是「解决」）。
-- 财务录一次全科目的期初（试算平衡的借/贷两侧），勾稽才真正为 0。
--
-- 三处刻意的取舍：
--   1. **金额存「方向 + 正数金额」**（direction + amount），不存负数 —— 与 voucher_lines /
--      cash_flow_entries 同一约定：库层不存负数，方向由列决定，报表不必猜符号；
--   2. **科目键与凭证同一套**（subject_key = `分类/名称`），这样期初余额与凭证余额能直接相加，
--      不需要一张「科目 id → 键」的翻译表；
--   3. **唯一键 (as_of_date, subject_key, currency) 软删除后仍占位**：与 overhead_allocations 同一处理。
--      「整批替换」时按这个三元组 upsert（把软删的那条恢复回来），因此不会出现
--      「同一科目两条期初、报表用哪条」的歧义。
CREATE TABLE "accounting_opening_balances" (
    "id" UUID NOT NULL,
    "as_of_date" DATE NOT NULL,
    "subject_key" VARCHAR(200) NOT NULL,
    "subject_label" VARCHAR(200) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "accounting_opening_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounting_opening_balances_as_of_date_subject_key_currency_key" ON "accounting_opening_balances"("as_of_date", "subject_key", "currency");

CREATE INDEX "accounting_opening_balances_as_of_date_currency_idx" ON "accounting_opening_balances"("as_of_date", "currency");
