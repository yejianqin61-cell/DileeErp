-- 订单号的唯一性改成「只在未删除的行上唯一」，于是**软删一张销售单就释放它的订单号**。
--
-- 为什么：2026-10-08 起草稿销售单可以删除（`SALES_ORDER_NOT_DELETABLE` 守卫 + 软删 + 审计），
-- 而原来的 `sales_orders_order_no_key` 是一条普通唯一索引，不看 `deleted_at` ——
-- 「删掉一张号写错的草稿，再用同一个号重新建单」会被数据库直接拒掉（P2002），
-- 而那时列表上已经看不到那张单，用户只能对着一个不存在的号反复重试。
-- 用户 2026-10-08 拍板：删除要释放订单号。
--
-- 重复数据守卫：建 partial unique 之前，未删除的行里如果已经有重复订单号，索引建不上。
-- 这种情况下**必须先人工处理**，不能让迁移半途失败（与 `20260826100000_unique_editable_bom` 同一做法）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sales_orders"
    WHERE "deleted_at" IS NULL
    GROUP BY "order_no"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one live sales order per order_no while duplicate order numbers exist among non-deleted rows. Resolve the duplicates before applying this migration.';
  END IF;
END $$;

DROP INDEX IF EXISTS "sales_orders_order_no_key";
CREATE UNIQUE INDEX "sales_orders_order_no_active_key" ON "sales_orders"("order_no") WHERE "deleted_at" IS NULL;
