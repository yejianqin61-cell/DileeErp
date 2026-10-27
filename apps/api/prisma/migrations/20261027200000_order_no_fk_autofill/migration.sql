-- 27 张表的外键自动填充（阶段 5 收口）。
--
-- 为什么需要触发器：回填只覆盖历史行，而行是由十几个 service 建的。逐个改写入点意味着
-- 十几处改动同时上线；把「order_no → sales_order_id」这一条规则放在数据库里，一处覆盖全部写入，
-- 服务代码零改动。代价是数据库里多了一段业务规则，所以规则只此一条、只读 sales_orders。
--
-- 口径：
--   · 只认未软删的销售单；对不上任何单时写 NULL，不阻塞写入（现金流/应付台账的号可手填）。
--   · 每次 order_no 变化都重新解析：改号后自动指向同一张销售单（id 不变，解析结果不变）。
--   · SalesOrder 自己与 audit_events 不挂触发器。

CREATE OR REPLACE FUNCTION fill_sales_order_id() RETURNS trigger AS $$
BEGIN
  IF NEW.order_no IS NULL THEN
    NEW.sales_order_id := NULL;
    RETURN NEW;
  END IF;
  SELECT s.id INTO NEW.sales_order_id
  FROM sales_orders s
  WHERE s.order_no = NEW.order_no AND s.deleted_at IS NULL
  LIMIT 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
  targets text[] := ARRAY['purchase_receipts', 'incoming_inspections', 'raw_material_inbound_notices', 'raw_material_inbounds', 'payable_sources', 'outsource_logistics_batches', 'outsource_receipts', 'outsource_payable_sources', 'outsource_return_transfers', 'outsource_direct_shipments', 'raw_material_movements', 'operation_daily_reports', 'employee_daily_reports', 'production_daily_alerts', 'production_payroll_sources', 'inventory_facts', 'finished_goods_inspection_submissions', 'finished_goods_qc_records', 'finished_goods_inbound_notices', 'finished_goods_inbounds', 'finished_goods_defectives', 'supplier_payable_entries', 'supplier_payments', 'supplier_payment_allocations', 'supplier_payable_reconciliations', 'cash_flow_entries', 'payroll_payable_entries'];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fill_sales_order_id ON %I', t);
    EXECUTE format('CREATE TRIGGER fill_sales_order_id BEFORE INSERT OR UPDATE OF order_no ON %I FOR EACH ROW EXECUTE FUNCTION fill_sales_order_id()', t);
  END LOOP;
END $$;