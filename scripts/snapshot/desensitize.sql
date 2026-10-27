-- 生产快照脱敏（在本地快照库上执行，不碰生产）。
--
-- 目标：让快照能用于报表/对账口径验证，同时不带出人身信息。
-- 边界：只处理本文件列出的列；业务单据的 remark 自由文本**未**处理，快照不要外发。
--
-- 用法：
--   docker cp scripts/snapshot/desensitize.sql <local-container>:/tmp/desensitize.sql
--   docker exec <local-container> psql -U dilee -d <snapshot-db> -v ON_ERROR_STOP=1 -f /tmp/desensitize.sql

BEGIN;

-- 1. 主体信息：编码、名称、地址、备注
UPDATE customers SET customer_code = 'C-' || left(id::text, 8), name = '客户-' || left(id::text, 8), address = '地址已脱敏', remark = NULL;
UPDATE customer_contacts SET name = '联系人-' || left(id::text, 8), phone = '13800000000', email = NULL, remark = NULL;
UPDATE suppliers SET supplier_code = 'S-' || left(id::text, 8), name = '供应商-' || left(id::text, 8), contact_name = '联系人', phone = '13800000000', address = '地址已脱敏', remark = NULL;
UPDATE employees SET name = '员工-' || left(id::text, 8), id_card_no = NULL, remark = NULL;

-- 2. 账号：用户名与显示名脱敏，口令一律作废（快照不用于登录）
UPDATE users SET username = 'user-' || left(id::text, 8), display_name = '用户-' || left(id::text, 8), password_hash = 'disabled';

-- 3. 附件：只留元数据形状，文件名与存储键脱敏
UPDATE attachments SET file_name = 'file-' || left(id::text, 8), storage_key = 'scrubbed';

-- 4. JSONB 快照里常见的人名/电话/地址键（只处理顶层键）
CREATE OR REPLACE FUNCTION mask_snapshot(value jsonb) RETURNS jsonb AS $fn$
DECLARE
  result jsonb := value;
  key text;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  FOREACH key IN ARRAY ARRAY['name','contact','contact_name','phone','address','email'] LOOP
    IF result ? key THEN
      result := jsonb_set(result, ARRAY[key], to_jsonb('已脱敏'::text));
    END IF;
  END LOOP;
  RETURN result;
END;
$fn$ LANGUAGE plpgsql;

UPDATE bom_items SET material_snapshot = mask_snapshot(material_snapshot), supplier_snapshot = mask_snapshot(supplier_snapshot);
UPDATE purchase_order_items SET material_snapshot = mask_snapshot(material_snapshot), supplier_snapshot = mask_snapshot(supplier_snapshot);
UPDATE purchase_plan_items SET material_snapshot = mask_snapshot(material_snapshot), supplier_snapshot = mask_snapshot(supplier_snapshot);
UPDATE purchase_orders SET supplier_snapshot = mask_snapshot(supplier_snapshot);
UPDATE sales_orders SET customer_snapshot = mask_snapshot(customer_snapshot), contact_snapshot = mask_snapshot(contact_snapshot);
UPDATE payroll_ledgers SET source_snapshot = mask_snapshot(source_snapshot);
UPDATE payroll_payable_entries SET source_snapshot = mask_snapshot(source_snapshot);
UPDATE production_payroll_sources SET source_snapshot = mask_snapshot(source_snapshot);

DROP FUNCTION mask_snapshot(jsonb);

-- 5. 不参与口径验证的业务过程数据：审计与 Agent 会话含自然语言原文
TRUNCATE audit_events;
TRUNCATE agent_run_events, agent_runs, agent_sessions;

COMMIT;
