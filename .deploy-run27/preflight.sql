-- 币种迁移预检
-- 1) 带 currency 列的业务表及其类型（迁移会 btrim 这些列）
SELECT c.table_name, c.data_type
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
WHERE c.table_schema = 'public' AND c.column_name = 'currency' AND t.table_type = 'BASE TABLE'
ORDER BY c.table_name;

-- 2) 现阶段实际出现过的币种取值（将被补成「历史值」字典项）
SELECT 'sales_orders' AS src, currency, count(*) FROM sales_orders WHERE currency IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'purchase_orders', currency, count(*) FROM purchase_orders WHERE currency IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'supplier_payable_entries', currency, count(*) FROM supplier_payable_entries WHERE currency IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'customer_payments', currency, count(*) FROM customer_payments WHERE currency IS NOT NULL GROUP BY 1,2
UNION ALL
SELECT 'payroll_ledgers', currency, count(*) FROM payroll_ledgers WHERE currency IS NOT NULL GROUP BY 1,2
ORDER BY 1,2;

-- 3) dictionary_items 是否有 (type_id, key) 唯一约束（ON CONFLICT 依赖它）
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'dictionary_items';

-- 4) 币种字典是否已存在（幂等）
SELECT count(*) AS currency_type_exists FROM dictionary_types WHERE key = 'currency' AND deleted_at IS NULL;

-- 5) 用户存在性（迁移无用户时直接返回）
SELECT count(*) AS users_total FROM users;
