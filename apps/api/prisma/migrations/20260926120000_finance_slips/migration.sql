-- 收/付款单的存档（用户 2026-09-26：「付款单要有填写汇率的地方，**保存键**」）。
--
-- 2026-09-20 的口径是「单子不落库 —— 它是一张打印件，不是系统单据」。这一轮它落库了，
-- 但**仍然不是账务单据**：保存不改任何账（不写收支流水、不生成凭证、不动应付/应收状态）。
-- 落库解决的是「财务改到一半关掉弹窗，那张单子就没了」——一次集中付款十几张，
-- 她只能从头再勾一遍、再改一遍。口径的完整说明在 schema.prisma 的 `FinanceSlip` 注释上。
--
-- 与**迁移**有关的三条取舍：
--
--   1. 分录行是**从表**（`finance_slip_lines`）而不是一个 JSON 列：金额落在 `DECIMAL` 上时，
--      「这一侧没有金额」只能是 `NULL`（写 0 会被读成「确实为零」的事实），JSON 里做不到。
--      形状与凭证分录（`voucher_lines`）一致，`line_no` 从 1 开始（就是单子上的行号）。
--   2. `slip_no` **不加唯一约束**：编号是财务本子上的东西（界面上可改），加唯一约束会让她
--      导出不了重号的那张。系统给的只是建议值。
--   3. `source_entry_ids` 是 JSONB 且**不建外键**：勾选的应付/应收条目可以被删掉，
--      而这张单子已经打出去、必须留着。
CREATE TABLE "finance_slips" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "slip_no" VARCHAR(100) NOT NULL,
    "slip_date" DATE NOT NULL,
    "slip_method" VARCHAR(50) NOT NULL,
    "counterparty_name" VARCHAR(200) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'CNY',
    "exchange_rate" DECIMAL(18,8),
    "amount_cny" DECIMAL(18,4),
    "our_bank_name" VARCHAR(200) NOT NULL DEFAULT '',
    "our_bank_account" VARCHAR(100) NOT NULL DEFAULT '',
    "counterparty_bank_name" VARCHAR(200) NOT NULL DEFAULT '',
    "counterparty_bank_account" VARCHAR(100) NOT NULL DEFAULT '',
    "attachment_count" INTEGER NOT NULL DEFAULT 1,
    "remark" VARCHAR(1000) NOT NULL DEFAULT '',
    "maker" VARCHAR(100) NOT NULL DEFAULT '',
    "source_entry_ids" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finance_slips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "finance_slip_lines" (
    "id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "summary" VARCHAR(500) NOT NULL DEFAULT '',
    "general_subject" VARCHAR(200) NOT NULL DEFAULT '',
    "detail_subject" VARCHAR(200) NOT NULL DEFAULT '',
    "debit" DECIMAL(18,4),
    "credit" DECIMAL(18,4),
    "remark" VARCHAR(500) NOT NULL DEFAULT '',

    CONSTRAINT "finance_slip_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "finance_slips_kind_slip_date_idx" ON "finance_slips"("kind", "slip_date");

CREATE UNIQUE INDEX "finance_slip_lines_slip_id_line_no_key" ON "finance_slip_lines"("slip_id", "line_no");

ALTER TABLE "finance_slip_lines" ADD CONSTRAINT "finance_slip_lines_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "finance_slips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
