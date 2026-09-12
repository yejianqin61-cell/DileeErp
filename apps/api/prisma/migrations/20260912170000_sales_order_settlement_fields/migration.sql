-- 销售单增加结算口径字段：结算币价 / 应收金额 / 结算方式 / 本币金额。
-- 全部可空：历史销售单没有这些信息，新建时也允许先不填（业务上可随后补录）。
ALTER TABLE "sales_orders" ADD COLUMN "settlement_unit_price" DECIMAL(18,4);
ALTER TABLE "sales_orders" ADD COLUMN "receivable_amount" DECIMAL(18,4);
ALTER TABLE "sales_orders" ADD COLUMN "settlement_method" VARCHAR(30);
ALTER TABLE "sales_orders" ADD COLUMN "local_currency_amount" DECIMAL(18,4);
