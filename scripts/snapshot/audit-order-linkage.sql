-- 单号联动一致性审计：文本键（order_no）与外键（sales_order_id）是否仍然指同一张销售单。
--
-- 为什么需要它：读路径还有大量靠 order_no 关联的地方（报表、对账、预views）。
-- 只要「有单号的行一定能解析出外键、且外键指向的销售单单号与该行文本一致」，
-- 用文本 join 和用 id join 查到的行就是同一批 —— 换不换 join 是等价改写。
-- 一旦这里出现 mismatch 或 orphan，才说明两条路会分叉，那时再换 join 才有意义。
--
-- 用法（对任意库执行，只读）：
--   docker cp scripts/snapshot/audit-order-linkage.sql <container>:/tmp/audit.sql
--   docker exec <container> psql -U dilee -d <db> -f /tmp/audit.sql
--
-- 输出：每张表一行；最后一段给出汇总。mismatched 与 orphan 都必须为 0。

-- 注意：不加 ON COMMIT DROP —— psql 逐条自动提交，加了会在 CREATE 之后立刻消失。
CREATE TEMP TABLE linkage_audit (
  table_name text,
  total bigint,
  linked bigint,
  mismatched bigint,
  orphan bigint
);

DO $$
DECLARE
  t text;
  sql text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'sales_order_id'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns k
        WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'order_no'
      )
    ORDER BY c.table_name
  LOOP
    sql := format($f$
      INSERT INTO linkage_audit
      SELECT %L,
             count(*),
             count(x.sales_order_id),
             count(*) FILTER (
               WHERE x.sales_order_id IS NOT NULL
                 AND x.order_no IS DISTINCT FROM (SELECT s.order_no FROM sales_orders s WHERE s.id = x.sales_order_id)
             ),
             count(*) FILTER (
               WHERE x.order_no IS NOT NULL AND x.order_no <> ''
                 AND x.sales_order_id IS NULL
             )
      FROM %I x
    $f$, t, t);
    EXECUTE sql;
  END LOOP;
END $$;

\echo '=== 明细（mismatched/orphan 必须为 0）==='
SELECT table_name, total, linked, mismatched, orphan
FROM linkage_audit
ORDER BY table_name;

\echo '=== 汇总 ==='
SELECT
  count(*) AS tables,
  sum(total) AS rows_total,
  sum(linked) AS rows_linked,
  sum(mismatched) AS mismatched,
  sum(orphan) AS orphan
FROM linkage_audit;

\echo '=== 结论（两列都为 0 才算通过）==='
SELECT
  CASE WHEN sum(mismatched) = 0 AND sum(orphan) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict,
  sum(mismatched) AS mismatched,
  sum(orphan) AS orphan
FROM linkage_audit;
