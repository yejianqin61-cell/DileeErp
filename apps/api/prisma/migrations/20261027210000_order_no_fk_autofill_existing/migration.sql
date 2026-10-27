-- 已有 sales_order_id 的 11 张表补触发器与回填。
--
-- 为什么还要这一份：这 11 张表的外键列是旧代码建的，由各 service 自己填。
-- 审计发现 customer_payments 有 6 行 order_no 有值但外键为空 —— 服务漏填就会空，
-- 而空值会让「按 id join」的读路径丢掉这些行。统一交给触发器填，规则只此一条。

UPDATE "boms" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "customer_payments" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "customer_returns" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "finished_goods_outbound_notices" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "finished_goods_outbounds" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "production_orders" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "purchase_orders" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "purchase_plans" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "receivable_adjustments" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "receivable_reconciliations" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

UPDATE "receivable_sources" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;

DO $do$
DECLARE
  t text;
  targets text[] := ARRAY['boms', 'customer_payments', 'customer_returns', 'finished_goods_outbound_notices', 'finished_goods_outbounds', 'production_orders', 'purchase_orders', 'purchase_plans', 'receivable_adjustments', 'receivable_reconciliations', 'receivable_sources'];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fill_sales_order_id ON %I', t);
    EXECUTE format('CREATE TRIGGER fill_sales_order_id BEFORE INSERT OR UPDATE OF order_no ON %I FOR EACH ROW EXECUTE FUNCTION fill_sales_order_id()', t);
  END LOOP;
END $do$;
