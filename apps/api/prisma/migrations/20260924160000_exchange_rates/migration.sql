-- 期末汇率表（财务 2026-09-24：「1,3,4 都要」里的第 ④ 件 —— 期末汇率表 + 外币折算）。
-- 设计见 docs/design/finance-three-statements-2026-09-24.md §8.2。
--
-- 为什么必须建这张表：凭证上有 currency，但没有汇率；三大报表是**人民币**报表。
-- 不折算就只能按币种分列（表尾写「不跨币种相加，其它币种未折算」）—— 那是说明，不是报表。
-- 有了这张表，`finance-three-statements.service.ts` 取数时把外币分录逐行折成人民币，
-- 三张表与模板的勾稽才在**跨币种**的情况下也成立。
--
-- 三处有意的取舍：
--   1. **按「期间 YYYY-MM」而不是记账日期**：财务维护的心智是「9 月的汇率」，
--      月底最后一天是 28/30/31 号不该影响取数；取数时按「不晚于该期间的最近一条」回退
--      （9 月没维护就用 8 月的，并在表尾说明），而不是拿未来汇率折过去的余额；
--   2. **本币 CNY 不录**：本币对自身恒为 1，录进来只会多一个「报表到底用哪条」的歧义，
--      服务层直接拒绝（LOCAL_CURRENCY_RATE）；
--   3. **唯一键 (period, currency) 软删除后仍占位**（与 accounting_opening_balances、
--      overhead_allocations 同一处理）：整批替换时按这个二元组 upsert（把软删的那条恢复回来），
--      因此不会出现「同一期间同一币种两条汇率」。
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_period_currency_key" ON "exchange_rates"("period", "currency");

CREATE INDEX "exchange_rates_currency_period_idx" ON "exchange_rates"("currency", "period");
