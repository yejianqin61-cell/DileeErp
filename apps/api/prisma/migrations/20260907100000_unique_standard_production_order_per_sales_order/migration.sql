DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "production_orders"
    WHERE "deleted_at" IS NULL
      AND "production_order_type" = 'standard'
      AND "parent_production_order_id" IS NULL
    GROUP BY "sales_order_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one standard production order per sales order while duplicate active standard production orders exist. Resolve the duplicate standard production orders (supplement/rework/split child orders are unaffected) before applying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "production_orders_sales_order_id_standard_root_key"
  ON "production_orders"("sales_order_id")
  WHERE "deleted_at" IS NULL AND "production_order_type" = 'standard' AND "parent_production_order_id" IS NULL;
