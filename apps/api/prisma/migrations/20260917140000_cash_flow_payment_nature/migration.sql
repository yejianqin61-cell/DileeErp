-- 收支流水增加两个列：`payment_nature`（款项性质）与 `order_no`（订单号）。
--
-- 需求来源：用户 2026-09-17 要求把老表 `example/财务/外汇一览表.xlsx` 搬成系统导出。
-- 那张表把每个订单的到账拆成「定金（日期 + 金额）/ 货款（日期 + 金额）」两组，于是必须能回答
-- 「这笔汇进来的钱是定金还是货款」。系统里没有任何字段能回答这个问题，用户选定
-- 「加在【收支流水】上，并给收入流水加一个可选订单号」。
--
-- 为什么加在收支流水上，而不是加在某个单据上：
--   钱进来只有两条路 ——【确认应收】自动写一条流水（sourceType = receivable_source /
--   receivable_reconciliation）、【收支流水】里手工录一笔。两条路最终都落在 cash_flow_entries，
--   所以「这笔钱是什么性质」只有记在它身上才不会在两条路之间丢失或打架。
--
-- 为什么还需要 order_no：
--   定金在**出货之前**就收到了，而应收来源是成品出库过账时生成的 —— 定金到账那一刻系统里
--   根本还没有可挂的来源。所以手工录的定金流水没有任何 sourceId 可用，外汇一览表要按订单归集，
--   只能靠一个能手工填的订单号。（历史流水没有这个值，报表把它们按「无法归属」列进表尾说明，
--   不猜、不静默丢弃。）
--
-- 两列都可空：历史流水、以及房租水电这类本来就没有订单号/款项性质的收支，
-- 不该被迫编一个值出来填满 NOT NULL。报表把「款项性质为空」算进「其他到账」并显式说明。
ALTER TABLE "cash_flow_entries" ADD COLUMN "payment_nature" VARCHAR(20);
ALTER TABLE "cash_flow_entries" ADD COLUMN "order_no" VARCHAR(100);

-- 外汇一览表按订单号归集收款（定金流水没有 sourceId 可挂，只能按订单号找）；
-- 订单详情页要反查「这张单收过几次钱」也走这条索引。
CREATE INDEX "cash_flow_entries_order_no_idx" ON "cash_flow_entries"("order_no");
