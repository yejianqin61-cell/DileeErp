-- =============================================================================
-- Dilee ERP · 财务治理 R2/R3 · 存量数据盘点与修复脚本
-- 文件：apps/api/prisma/maintenance/2026-11-09-finance-repair.sql
-- 日期：2026-11-09（R3-8）
-- 目标库：PostgreSQL 16 / 库 dilee_erp / 用户 dilee / 容器 app-postgres-1
-- =============================================================================
--
-- 【这个脚本做什么】
--   把「仓库改不动的历史财务数据」变成可审阅的清单 + 可重复执行的修复 SQL。
--   默认只读：§0/§1 全是 SELECT；§2 每段的修复语句都被 `--` 注释，需人工确认后取消注释。
--
-- 【生产现状（2026-11-09 盘点时）】
--   - _prisma_migrations 最新只到 20261105103000；
--     R1 迁移 20261107200000_accounting_subject_categories、
--     R3 迁移 20261109130000_finance_governance_r3 均【未应用】。
--   - 因此 voucher_lines.subject_id / business_subject_* / supplier_payable_entries.invoice_type
--     在生产库【不存在】。本脚本不写死这些列：凡引用新列的语句一律用 information_schema
--     探测 + DO 块跳过（见 §0.2、§1.4b、§2.C）。
--   - 旧全局唯一索引 vouchers_source_type_source_id_key 仍在（迁移后会换成部分唯一索引）。
--
-- 【执行方式】
--   psql -U dilee -d dilee_erp -P pager=off -f apps/api/prisma/maintenance/2026-11-09-finance-repair.sql
--   只读盘点可直接整文件执行（修复段默认注释，不会写库）。
--
-- 【硬规则】
--   1. 先 §1 盘点 → 备份（§2.0）→ 再逐段取消注释执行 §2 → 按 §3 复核 → 记录影响行数（§5）。
--   2. 每段修复都必须满足幂等：WHERE 只命中「坏状态」，重复执行第二次影响 0 行。
--   3. 任何一段实际影响行数 ≠ §5 预期时，立即停止，不要执行后面的段；按 §4 回滚。
--   4. 修复 SQL 只处理「数据本身不合法」的存量；会计口径判断（科目该记哪个、红字该不该过账）
--      必须由财务确认，脚本不替财务做判断。
--
-- 【段目录】
--   §0 环境探测（只读）
--   §1 盘点（只读，可整跑）
--     1.1 总账/业务快照
--     1.2 草稿挂账凭证（按来源类型/金额/删除态）
--     1.3 无 posted 挂账的已确认应付
--     1.4 凭证行科目名快照无法回填 subject_id 的行
--     1.5 红字（红冲）凭证与红冲链
--     1.6 草稿流水凭证（R3-7 说明中提到的存量）
--   §2 修复段（默认注释；每段：盘点 SELECT → 修复 UPDATE/软删 → 回滚说明）
--     A. 孤儿草稿挂账凭证软删
--     B. 旧草稿凭证人工过账清单（只列不写）
--     C. 科目快照回填 / 人工映射（迁移后）
--     D. 红字凭证核对 + 可选处置（口径决定）
--   §3 复核（修复后只读）
--   §4 回滚
--   §5 预期影响行数（2026-11-09 生产快照）
--   §6 上线前人工处理 3 步
-- =============================================================================

\set ON_ERROR_STOP on
\pset pager off

-- =============================================================================
-- §0 环境探测（只读）
-- =============================================================================
\echo '=== 0.1 数据库与迁移状态 ==='
select version() as pg_version;

select migration_name, finished_at
from _prisma_migrations
order by finished_at desc nulls last
limit 3;

\echo '=== 0.2 新列/索引是否存在（决定后面哪些段可执行） ==='
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'supplier_payable_entries'
      and column_name = 'invoice_type')                as has_invoice_type,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'voucher_lines'
      and column_name = 'subject_id')                  as has_voucher_line_subject_id,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'voucher_lines'
      and column_name = 'business_subject_id')         as has_voucher_line_business_subject_id,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'voucher_lines'
      and column_name = 'business_subject_label')      as has_voucher_line_business_subject_label,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'vouchers_source_active_key')
                                                       as has_partial_unique_index,
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'vouchers_source_type_source_id_key')
                                                       as has_legacy_unique_index;

-- =============================================================================
-- §1 盘点（只读；可整文件直接执行，不会写库）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1.1 总账/业务快照
-- SQL 摘要：vouchers 按 status × deleted 分组；supplier_payable_entries 按 status × deleted 分组。
-- -----------------------------------------------------------------------------
\echo '=== 1.1a 凭证快照（按状态 × 删除态） ==='
select status,
       (deleted_at is not null) as is_deleted,
       count(*)                 as vouchers,
       sum(debit_total)::numeric(14,2) as debit_total
from vouchers
group by 1, 2
order by 1, 2;

\echo '=== 1.1b 应付款条快照（按状态 × 删除态） ==='
select status,
       (deleted_at is not null) as is_deleted,
       count(*)                 as payables,
       sum(amount)::numeric(14,2) as amount
from supplier_payable_entries
group by 1, 2
order by 1, 2;

-- -----------------------------------------------------------------------------
-- 1.2 草稿挂账凭证（按来源类型/金额/删除态）
-- SQL 摘要：source_type='supplier_payable'（挂账凭证）中 status='draft' 的全部凭证，
--           左连应付条目看来源单据状态；按 删除态 × 应付状态 汇总 + 逐张清单。
-- -----------------------------------------------------------------------------
\echo '=== 1.2a 草稿挂账凭证汇总（删除态 × 来源单据状态） ==='
select (v.deleted_at is not null)                as voucher_deleted,
       coalesce(e.status, '(source missing)')    as source_status,
       count(*)                                  as vouchers,
       sum(v.debit_total)::numeric(14,2)         as debit_total
from vouchers v
left join supplier_payable_entries e on e.id = v.source_id
where v.source_type = 'supplier_payable'
  and v.status = 'draft'
group by 1, 2
order by 1, 2;

\echo '=== 1.2b 草稿挂账凭证逐张清单 ==='
select v.voucher_no,
       v.voucher_date,
       v.debit_total::numeric(14,2)               as amount,
       (v.deleted_at is not null)                 as voucher_deleted,
       v.deleted_at,
       e.payable_no,
       e.status                                   as payable_status,
       (e.deleted_at is not null)                 as payable_deleted
from vouchers v
left join supplier_payable_entries e on e.id = v.source_id
where v.source_type = 'supplier_payable'
  and v.status = 'draft'
order by v.voucher_no;

\echo '=== 1.2c 草稿流水凭证汇总（source_type=cash_flow_entry） ==='
select (v.deleted_at is not null)             as voucher_deleted,
       coalesce(f.status, '(source missing)') as flow_status,
       count(*)                               as vouchers,
       sum(v.debit_total)::numeric(14,2)      as debit_total
from vouchers v
left join cash_flow_entries f on f.id = v.source_id
where v.source_type = 'cash_flow_entry'
  and v.status = 'draft'
group by 1, 2
order by 1, 2;

\echo '=== 1.2d 存活草稿凭证逐张清单（不论来源，供人工过账/作废） ==='
select v.voucher_no,
       v.source_type,
       v.debit_total::numeric(14,2) as amount,
       v.voucher_date,
       case
         when v.source_type = 'supplier_payable' then e.payable_no
         when v.source_type = 'cash_flow_entry'  then f.entry_no
         else v.source_id::text
       end                          as source_no,
       coalesce(e.status, f.status) as source_status
from vouchers v
left join supplier_payable_entries e on v.source_type = 'supplier_payable' and e.id = v.source_id
left join cash_flow_entries       f on v.source_type = 'cash_flow_entry'  and f.id = v.source_id
where v.status = 'draft'
  and v.deleted_at is null
order by v.voucher_no;

-- -----------------------------------------------------------------------------
-- 1.3 无 posted 挂账的已确认应付
-- SQL 摘要：未删除且 status='confirmed' 的应付，排除「存在未删除且 posted 的挂账凭证」者；
--           再按「有没有任何凭证 / 有没有存活凭证」细分，给业务侧「按来源重算」的依据。
-- -----------------------------------------------------------------------------
\echo '=== 1.3a 无 posted 挂账的已确认应付（汇总） ==='
select count(*)                        as confirmed_without_posted_accrual,
       sum(e.amount)::numeric(14,2)    as amount
from supplier_payable_entries e
where e.deleted_at is null
  and e.status = 'confirmed'
  and not exists (
        select 1 from vouchers v
         where v.source_type = 'supplier_payable'
           and v.source_id = e.id
           and v.deleted_at is null
           and v.status = 'posted');

\echo '=== 1.3b 逐条清单（含存活/全部凭证数，便于判断走「按来源重算」还是人工过账） ==='
select e.payable_no,
       e.status,
       e.amount::numeric(14,2)          as amount,
       e.confirmation_date,
       (select count(*) from vouchers v
         where v.source_type = 'supplier_payable' and v.source_id = e.id
           and v.deleted_at is null)     as live_vouchers,
       (select count(*) from vouchers v
         where v.source_type = 'supplier_payable' and v.source_id = e.id
           and v.deleted_at is null and v.status = 'posted') as live_posted,
       (select count(*) from vouchers v
         where v.source_type = 'supplier_payable' and v.source_id = e.id) as all_vouchers
from supplier_payable_entries e
where e.deleted_at is null
  and e.status = 'confirmed'
  and not exists (
        select 1 from vouchers v
         where v.source_type = 'supplier_payable'
           and v.source_id = e.id
           and v.deleted_at is null
           and v.status = 'posted')
order by e.payable_no;

\echo '=== 1.3c 参考：无 posted 挂账的已付应付（历史遗留，只统计不处理） ==='
select count(*)                     as paid_without_posted_accrual,
       sum(e.amount)::numeric(14,2) as amount
from supplier_payable_entries e
where e.deleted_at is null
  and e.status = 'paid'
  and not exists (
        select 1 from vouchers v
         where v.source_type = 'supplier_payable'
           and v.source_id = e.id
           and v.deleted_at is null
           and v.status = 'posted');

-- -----------------------------------------------------------------------------
-- 1.4 凭证行科目名快照无法回填 subject_id 的行
-- SQL 摘要：按 R3 迁移的回填规则（label = name / '分类 / 名称'，或 subject_key = '分类/名称'，
--           且科目未软删除）统计每行可命中的科目数：0=无法回填，1=可回填，>1=歧义；
--           列出 0 命中的行（迁移前/后都适用，只用老列）。
-- 注意：本段不依赖 voucher_lines.subject_id，生产（迁移前）可直接执行。
-- -----------------------------------------------------------------------------
\echo '=== 1.4a 按回填规则的可命中数分类（0=无法回填 / 1=可回填 / >1=歧义） ==='
with cand as (
  select l.id,
         l.amount,
         (select count(*)
            from accounting_subjects s
           where s.deleted_at is null
             and (l.subject_label = s.name
                  or l.subject_label = s.category || ' / ' || s.name
                  or l.subject_key   = s.category || '/' || s.name)) as hits
  from voucher_lines l
)
select case when hits = 0 then 'none(cannot backfill)'
            when hits = 1 then 'unique(backfillable)'
            else               'ambiguous(leave null)' end as resolution,
       count(*)                 as lines,
       sum(amount)::numeric(14,2) as amount
from cand
group by 1
order by 1;

\echo '=== 1.4b 无法回填的凭证行逐行清单（迁移前按 label，迁移后 subject_id 会留空） ==='
with cand as (
  select l.*,
         (select count(*)
            from accounting_subjects s
           where s.deleted_at is null
             and (l.subject_label = s.name
                  or l.subject_label = s.category || ' / ' || s.name
                  or l.subject_key   = s.category || '/' || s.name)) as hits
  from voucher_lines l
)
select v.voucher_no,
       v.status,
       (v.deleted_at is not null) as voucher_deleted,
       l.direction,
       l.subject_key,
       l.subject_label,
       l.amount::numeric(14,2) as amount
from cand l
join vouchers v on v.id = l.voucher_id
where l.hits = 0
order by v.voucher_no, l.line_no;

\echo '=== 1.4c 无法回填行按「凭证删除态 × 状态」汇总（判断是否还要处理） ==='
with cand as (
  select l.id, l.amount, v.status as vstatus, v.deleted_at as vdeleted,
         (select count(*)
            from accounting_subjects s
           where s.deleted_at is null
             and (l.subject_label = s.name
                  or l.subject_label = s.category || ' / ' || s.name
                  or l.subject_key   = s.category || '/' || s.name)) as hits
  from voucher_lines l
  join vouchers v on v.id = l.voucher_id
)
select (vdeleted is not null) as voucher_deleted,
       vstatus,
       count(*)               as lines,
       sum(amount)::numeric(14,2) as amount
from cand
where hits = 0
group by 1, 2
order by 1, 2;

-- 1.4d 迁移后的补充盘点：subject_id 仍为空的行（列不存在时只打印提示，不报错）
\echo '=== 1.4d 迁移后补充：subject_id 仍为空的行（迁移前自动跳过） ==='
do $$
declare
  v_has_col boolean;
  v_lines   bigint;
  v_amt     numeric;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'voucher_lines' and column_name = 'subject_id'
  ) into v_has_col;

  if not v_has_col then
    raise notice 'voucher_lines.subject_id 不存在（迁移前）：跳过 1.4d';
    return;
  end if;

  execute 'select count(*), coalesce(sum(amount),0) from voucher_lines where subject_id is null'
    into v_lines, v_amt;
  raise notice '迁移后 subject_id 仍为空：% 行 / %', v_lines, v_amt;
end $$;

-- -----------------------------------------------------------------------------
-- 1.5 红字（红冲）凭证与红冲链
-- SQL 摘要：source_type='voucher' 的红字凭证逐张列出（原凭证状态/删除态）；
--           递归 CTE 还原红冲链；核对 posted 红字凭证的分录是否与原凭证镜像。
-- -----------------------------------------------------------------------------
\echo '=== 1.5a 红字凭证逐张清单 ==='
select v.voucher_no,
       v.status                          as red_status,
       v.debit_total::numeric(14,2)      as amount,
       v.voucher_date,
       o.voucher_no                      as original_voucher_no,
       o.status                          as original_status,
       (o.deleted_at is not null)        as original_deleted,
       o.source_type                     as original_source_type
from vouchers v
left join vouchers o on o.id = v.source_id
where v.source_type = 'voucher'
order by v.voucher_no;

\echo '=== 1.5b posted 红字凭证汇总（R1 之后不应再新增：VOUCHER_RED_NOT_REVERSIBLE） ==='
select count(*)                                   as red_posted,
       sum(v.debit_total)::numeric(14,2)          as amount,
       count(*) filter (where o.status = 'reversed') as original_already_reversed
from vouchers v
left join vouchers o on o.id = v.source_id
where v.source_type = 'voucher'
  and v.status = 'posted';

\echo '=== 1.5c 红冲链（递归；列出长度 >= 2 的红字链） ==='
with recursive chain as (
  -- 链根：红字凭证的原凭证不是红字（即第一次红冲）
  select v.id            as red_id,
         v.voucher_no    as red_no,
         v.status        as red_status,
         o.voucher_no    as orig_no,
         o.status        as orig_status,
         1               as depth,
         v.id            as root_id,
         v.voucher_no    as root_no
  from vouchers v
  join vouchers o on o.id = v.source_id
  where v.source_type = 'voucher'
    and o.source_type <> 'voucher'
  union all
  select v.id, v.voucher_no, v.status, o.voucher_no, o.status,
         c.depth + 1, c.root_id, c.root_no
  from chain c
  join vouchers v on v.source_type = 'voucher' and v.source_id = c.red_id
  left join vouchers o on o.id = v.source_id
)
select root_no as root_red_voucher,
       max(depth) as red_chain_length,
       string_agg(red_no || '(' || red_status || ')', ' -> ' order by depth) as chain
from chain
group by root_id, root_no
having max(depth) >= 2
order by red_chain_length desc;

\echo '=== 1.5d posted 红字凭证的分录是否与原凭证镜像（应为 OK） ==='
with red as (
  select v.id, v.voucher_no, v.source_id
  from vouchers v
  where v.source_type = 'voucher' and v.status = 'posted'
)
select r.voucher_no as red_no,
       o.voucher_no as orig_no,
       (select sum(l.amount) from voucher_lines l where l.voucher_id = r.id and l.direction = 'debit')::numeric(14,2)  as red_debit,
       (select sum(l.amount) from voucher_lines l where l.voucher_id = r.id and l.direction = 'credit')::numeric(14,2) as red_credit,
       (select sum(l.amount) from voucher_lines l where l.voucher_id = o.id and l.direction = 'debit')::numeric(14,2)  as orig_debit,
       (select sum(l.amount) from voucher_lines l where l.voucher_id = o.id and l.direction = 'credit')::numeric(14,2) as orig_credit,
       case when (select sum(l.amount) from voucher_lines l where l.voucher_id = r.id and l.direction = 'debit')
                 = (select sum(l.amount) from voucher_lines l where l.voucher_id = o.id and l.direction = 'credit')
             and (select sum(l.amount) from voucher_lines l where l.voucher_id = r.id and l.direction = 'credit')
                 = (select sum(l.amount) from voucher_lines l where l.voucher_id = o.id and l.direction = 'debit')
            then 'OK' else 'MISMATCH' end as mirror_check
from red r
join vouchers o on o.id = r.source_id
order by r.voucher_no;

-- -----------------------------------------------------------------------------
-- 1.6 草稿流水凭证（R3-7「存量草稿流水凭证不自动过账」的盘点清单）
-- -----------------------------------------------------------------------------
\echo '=== 1.6 存活草稿流水凭证（需财务在凭证页人工过账或作废） ==='
select v.voucher_no,
       v.debit_total::numeric(14,2) as amount,
       f.entry_no                    as cash_flow_entry_no,
       f.status                      as flow_status,
       f.entry_date
from vouchers v
join cash_flow_entries f on f.id = v.source_id
where v.source_type = 'cash_flow_entry'
  and v.status = 'draft'
  and v.deleted_at is null
order by v.voucher_no;

-- =============================================================================
-- §2 修复段（默认全部注释；确认后逐段取消注释执行）
-- 每段结构：盘点 SELECT（可先跑）→ 修复 UPDATE/软删（幂等）→ 回滚说明
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.0 备份（写操作；执行任何修复前必做；默认注释）
-- 说明：备份表名带日期；确认修复完成并过了观察期后按保留策略清理。
-- -----------------------------------------------------------------------------
-- CREATE TABLE backup_20261109_vouchers AS SELECT * FROM vouchers;
-- CREATE TABLE backup_20261109_voucher_lines AS SELECT * FROM voucher_lines;
-- CREATE TABLE backup_20261109_supplier_payable_entries AS SELECT * FROM supplier_payable_entries;

-- -----------------------------------------------------------------------------
-- A. 孤儿草稿挂账凭证软删
-- 定义：status='draft'、未删除、来源=应付，但来源应付不存在 / 已软删除 / 状态不是 confirmed|paid
--       —— 这些凭证永远过不了账，也不该占着「挂账」位置。
-- 当前盘点（2026-11-09 生产）：0 行（历史上 8 张孤儿草稿已在应用层被软删，见 §1.2a）。
-- 本段是上线后的安全网：R1 起应用层用 discardDraftAccrual 软删，但仍可能有并发/手工数据。
-- -----------------------------------------------------------------------------
\echo '=== A. 盘点：孤儿草稿挂账凭证（修复前） ==='
select v.voucher_no,
       v.debit_total::numeric(14,2) as amount,
       v.source_id,
       e.status                     as source_status,
       (e.deleted_at is not null)   as source_deleted
from vouchers v
left join supplier_payable_entries e on e.id = v.source_id
where v.source_type = 'supplier_payable'
  and v.status = 'draft'
  and v.deleted_at is null
  and (e.id is null or e.deleted_at is not null or e.status not in ('confirmed', 'paid'))
order by v.voucher_no;

-- A-修复（幂等；取消注释后执行）：
--   影响行数应等于上面 SELECT 的行数；重复执行第二次为 0。
-- UPDATE vouchers v
--    SET deleted_at = now(),
--        updated_at = now()
--  WHERE v.source_type = 'supplier_payable'
--    AND v.status = 'draft'
--    AND v.deleted_at IS NULL
--    AND NOT EXISTS (
--          SELECT 1
--            FROM supplier_payable_entries e
--           WHERE e.id = v.source_id
--             AND e.deleted_at IS NULL
--             AND e.status IN ('confirmed', 'paid'));
--
-- A-回滚（从 A 盘点结果抄 voucher_no）：
-- UPDATE vouchers
--    SET deleted_at = NULL, updated_at = now()
--  WHERE voucher_no IN ('记-2026-XX-XXXX');
--   注意：迁移前旧全局唯一索引 (source_type, source_id) 仍在；若同一来源已另有存活凭证，
--         恢复会撞唯一键，此时不要强恢复，保留软删并人工核对。

-- -----------------------------------------------------------------------------
-- B. 旧草稿凭证人工过账清单（只列不写；SQL 不替财务过账）
-- 原因：R1 起「确认即过账」，自动凭证不再产生草稿；但历史草稿不会自动过账（R3-7 明示）。
--   过账动作必须走应用（凭证页/接口），才能带审计与状态机校验；不要用 SQL 直接改 status。
-- 当前盘点（2026-11-09 生产）：3 张存活草稿凭证
--   记-2026-11-0024 挂账草稿 69.90（来源应付 APO-20261027-051B0E17，paid）
--   记-2026-11-0023 流水草稿 27.20（来源流水 CF-20261105-9CFB412B，posted）
--   记-2026-11-0025 流水草稿 69.90（来源流水 CF-20261106-BDFBEF5F，posted）
-- 另：§1.3 的 4 条「无 posted 挂账的已确认应付」应走「按来源重算」（R3-6 reaccrue），
--     不是把已删除的草稿恢复回来。
-- ⚠️ 过账前先核对科目：这些历史草稿的科目方向存在已知错误（见盘点报告 §2.5），
--    直接过账会把错误带进总账；R1 只保证红字不入报表，不保证历史草稿科目正确。
-- -----------------------------------------------------------------------------
\echo '=== B. 盘点：待人工处理的草稿凭证 + 需重算挂账的已确认应付 ==='
-- B1 存活草稿凭证（= §1.2d，原样重复便于执行时定位）
select v.voucher_no,
       v.source_type,
       v.debit_total::numeric(14,2) as amount,
       v.voucher_date
from vouchers v
where v.status = 'draft'
  and v.deleted_at is null
order by v.voucher_no;

-- B2 需要「按来源重算」的已确认应付（= §1.3b）
select e.payable_no,
       e.amount::numeric(14,2) as amount,
       e.confirmation_date
from supplier_payable_entries e
where e.deleted_at is null
  and e.status = 'confirmed'
  and not exists (
        select 1 from vouchers v
         where v.source_type = 'supplier_payable'
           and v.source_id = e.id
           and v.deleted_at is null
           and v.status = 'posted')
order by e.payable_no;

-- B-修复：无（只列不写）。处理方式：
--   1) 草稿凭证：财务在凭证页逐张「过账」或「作废」；过账前先按 B 清单核对科目。
--   2) 已确认应付：R3-6 上线后调用 POST /finance/payables/:id/reaccrue 生成 posted 挂账；
--      若该应付已有已红冲挂账（如 APO-20261104-D403A398），reaccrue 正是设计用途。
--   3) 任何需要改科目/金额的，先红冲再重开，不要 SQL 直改。

-- -----------------------------------------------------------------------------
-- C. 科目名快照回填 / 人工映射
-- 背景：R3 迁移会对历史 voucher_lines 按「唯一同名」回填 subject_id（见迁移 §3）；
--       生产当前未迁移，本节在迁移后使用。
-- 当前盘点（2026-11-09 生产）：
--   68 行分录中 52 行可唯一回填（71,257.12），16 行无法回填（32,552.04），0 行歧义。
--   16 行 = 7 个标签：
--     其他应收款--（备用金）6 行/14,838.10
--     银行存款—中国银行人民币91350212685285642A 5 行/13,500.00
--     银行存款—招商银行6214851811022925 1 行/27.20
--     银行存款—中国农业银行40390001040045706 1 行/1,400.00
--     销售费 推广费 1 行/2,700.00（主数据为「销售费 -推广费」）
--     管理费 培训费 1 行/8.00（主数据为「培训费」）
--     库存现金（备用金）1 行/78.74（主数据为「其他应收款-备用金」）
-- 本段提供：C1 迁移前文本盘点（已有，见 §1.4）；C2 迁移后补跑自动回填；C3 人工映射模板。
-- -----------------------------------------------------------------------------
\echo '=== C. 盘点：迁移后 subject_id 仍为空的分录（迁移前自动跳过） ==='
do $$
declare
  v_has_col boolean;
  v_lines   bigint;
  v_amt     numeric;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'voucher_lines' and column_name = 'subject_id'
  ) into v_has_col;

  if not v_has_col then
    raise notice 'voucher_lines.subject_id 不存在（迁移前）：跳过 C 段自动回填；请先执行 R3 迁移';
    return;
  end if;

  execute 'select count(*), coalesce(sum(amount),0) from voucher_lines where subject_id is null'
    into v_lines, v_amt;
  raise notice '迁移后 subject_id 仍为空：% 行 / %（需 C3 人工映射或接受 label 兜底）', v_lines, v_amt;
end $$;

-- C2 迁移后补跑自动回填（= R3 迁移 §3 的同一逻辑；幂等：只更新 subject_id 为空的行）
--   适用：迁移执行中断、或手工插入过历史行。重复执行第二次影响 0 行。
--   取消注释前先确认 voucher_lines.subject_id 列存在（§0.2 = 1）。
-- WITH matched AS (
--   SELECT l."id" AS line_id, min(s."id") AS subject_id
--   FROM "voucher_lines" l
--   JOIN "accounting_subjects" s
--     ON s."deleted_at" IS NULL
--    AND (
--         l."subject_label" = s."name"
--      OR l."subject_label" = s."category" || ' / ' || s."name"
--      OR l."subject_key"   = s."category" || '/' || s."name"
--    )
--   WHERE l."subject_id" IS NULL
--   GROUP BY l."id"
--   HAVING count(*) = 1
-- )
-- UPDATE "voucher_lines" l
--    SET "subject_id" = m.subject_id
--   FROM matched m
--  WHERE l."id" = m.line_id
--    AND l."subject_id" IS NULL;
--
-- C-回滚：
-- UPDATE voucher_lines l
--    SET subject_id = NULL
--  WHERE l.id IN (
--        SELECT l2.id FROM voucher_lines l2
--        JOIN vouchers v ON v.id = l2.voucher_id
--        WHERE v.voucher_date < '2026-11-09'   -- C2 只可能改历史行，用日期圈定
--      );
--   （更稳妥：先备份 voucher_lines，再按备份恢复 subject_id 列。）
--
-- C3 人工映射模板（迁移后、且财务/会计确认「该文本应归到哪个科目」后启用）
--   规则：label → 科目名（必须全局唯一）；只更新 subject_id 仍为空的行；幂等。
--   默认 VALUES 为空 = 不执行；把确认过的映射填进去后取消整段注释。
-- WITH manual_map(label, subject_name) AS (
--   VALUES
--     ('其他应收款--（备用金）', '其他应收款-备用金'),
--     ('销售费 推广费',         '销售费 -推广费')
--     -- 银行存款账号明细类标签（含账号）建议映射到对应银行科目，需财务逐条确认：
--     -- ('银行存款—中国银行人民币91350212685285642A', '银行存款 中国银行（人民币）'),
--     -- ('银行存款—中国农业银行40390001040045706',    '银行存款 农业银行')
-- )
-- UPDATE voucher_lines l
--    SET subject_id = s.id
--   FROM manual_map m
--   JOIN accounting_subjects s
--     ON s.deleted_at IS NULL
--    AND s.name = m.subject_name
--  WHERE l.subject_id IS NULL
--    AND l.subject_label = m.label;
--
-- C-回滚（C3）：与 C2 相同，把 subject_id 置回 NULL 或按备份恢复。

-- -----------------------------------------------------------------------------
-- D. 红字凭证核对（R1 已保证红字凭证不入报表；本段只核对条数）
-- 当前盘点（2026-11-09 生产）：
--   红字凭证 13 张：10 张 reversed / 22,170.00 + 3 张 posted / 12,061.20；
--   13 张的原凭证状态全部是 reversed（对已作废凭证再红冲）；
--   红冲链 2 条：记-2026-11-0007 起 8 连、记-2026-11-0005 起 4 连；
--   3 张 posted 红字凭证的分录与原凭证完全镜像（mirror_check=OK）。
-- 结论：R1 后红字不入报表，这 3 张 posted 红字不会虚增报表；但它们仍占「已过账」状态，
--       且 R1 起接口不允许再红冲红字（VOUCHER_RED_NOT_REVERSIBLE），如需清理只能走人工 SQL。
-- -----------------------------------------------------------------------------
\echo '=== D. 盘点：红字凭证条数核对 ==='
select v.status                          as red_status,
       count(*)                          as vouchers,
       sum(v.debit_total)::numeric(14,2) as amount
from vouchers v
where v.source_type = 'voucher'
group by 1
order by 1;

-- D-修复（可选；需财务口径确认后再执行）：
--   语义：原凭证已 reversed，红字凭证不应保持 posted；置为 reversed 与 R1「红字不入报表」一致。
--   幂等：status='posted' 过滤；第二次影响 0 行。预期影响 3 行 / 12,061.20。
-- UPDATE vouchers v
--    SET status = 'reversed',
--        updated_at = now()
--  WHERE v.source_type = 'voucher'
--    AND v.status = 'posted'
--    AND v.deleted_at IS NULL
--    AND EXISTS (
--          SELECT 1 FROM vouchers o
--           WHERE o.id = v.source_id
--             AND o.status = 'reversed');
--
-- D-回滚（从 D 盘点结果抄 voucher_no）：
-- UPDATE vouchers
--    SET status = 'posted', updated_at = now()
--  WHERE voucher_no IN ('记-2026-10-0008', '记-2026-11-0018', '记-2026-11-0021');

-- =============================================================================
-- §3 复核（修复后只读；每段执行后跑对应复核）
-- =============================================================================
\echo '=== 3.1 复核 A：应无孤儿草稿挂账凭证（应为 0） ==='
select count(*) as orphan_draft_accrual_left
from vouchers v
left join supplier_payable_entries e on e.id = v.source_id
where v.source_type = 'supplier_payable'
  and v.status = 'draft'
  and v.deleted_at is null
  and (e.id is null or e.deleted_at is not null or e.status not in ('confirmed', 'paid'));

\echo '=== 3.2 复核 B：人工处理清单（处理后行数应下降） ==='
select count(*) as draft_alive_left from vouchers where status = 'draft' and deleted_at is null;

\echo '=== 3.3 复核 D：posted 红字凭证（执行 D 后应为 0） ==='
select count(*) as red_posted_left from vouchers where source_type = 'voucher' and status = 'posted';

\echo '=== 3.4 复核 C：迁移后 subject_id 为空的行（自动跳过迁移前） ==='
do $$
declare
  v_has_col boolean;
  v_lines   bigint;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'voucher_lines' and column_name = 'subject_id'
  ) into v_has_col;
  if not v_has_col then
    raise notice '迁移前：跳过 3.4';
    return;
  end if;
  execute 'select count(*) from voucher_lines where subject_id is null' into v_lines;
  raise notice 'subject_id 仍为空的行：%（预期 16，若 C3 人工映射后应下降）', v_lines;
end $$;

-- =============================================================================
-- §4 回滚
-- =============================================================================
-- 每段回滚语句已写在对应段注释里。整体回滚顺序：后执行的段先回滚。
-- 通用兜底（按备份恢复；写操作，仅在需要时取消注释）：
--   -- 先停应用或进入维护窗口，避免回滚期间被并发写
--   UPDATE vouchers v SET deleted_at = b.deleted_at, updated_at = now()
--     FROM backup_20261109_vouchers b WHERE v.id = b.id AND v.deleted_at IS DISTINCT FROM b.deleted_at;
--   UPDATE vouchers v SET status = b.status, updated_at = now()
--     FROM backup_20261109_vouchers b WHERE v.id = b.id AND v.status IS DISTINCT FROM b.status;
--   -- voucher_lines.subject_id 若迁移后回填过，也可按 backup_20261109_voucher_lines 恢复
-- 回滚后必须重跑 §1 盘点确认数字回到执行前快照。

-- =============================================================================
-- §5 预期影响行数（2026-11-09 生产快照；执行前用同口径 SELECT 复核）
-- =============================================================================
-- 段   动作                                  预期影响行数      说明
-- A    软删孤儿草稿挂账凭证                   0                当前无孤儿；安全网
-- B    人工处理清单（不写）                   3 张草稿 + 4 条应付 只列不写，走应用处理
-- C2   迁移后补跑自动回填 subject_id          52 行（首次）     已由迁移完成；补跑为 0
-- C3   人工映射                               0（默认空映射）   财务确认后逐条启用
-- D    红字凭证置 reversed（可选）             3 张 / 12,061.20  需财务口径确认
--
-- 执行顺序：§1 盘点 → §2.0 备份 → A（确认 0 行即可跳过）→ B（人工处理，不改库）
--           → 迁移后 C2/C3 → D（口径确认）→ §3 复核 → 记录影响行数。

-- =============================================================================
-- §6 上线前人工处理 3 步
-- =============================================================================
-- 1) 先迁移、再跑脚本：生产先应用 20261107200000_accounting_subject_categories 与
--    20261109130000_finance_governance_r3，确认 §0.2 的 5 个探测位=1，再跑 §1.4d/§1.5c 复核。
-- 2) 财务处理 3 张可过账草稿 + 4 条无 posted 挂账的已确认应付：
--    草稿在凭证页逐张「过账/作废」，已确认应付用 reaccrue；处理前先核对科目
--    （记-2026-11-0025 借 管理费 办公用品 / 贷 备用金，方向可疑）。
-- 3) 科目映射与红字口径确认：C3 的 7 个文本标签由财务指定科目（银行账号类逐条确认）；
--    D 段 3 张 posted 红字是否置 reversed 由财务拍板——两件事都落成 §5 的数字后再执行 SQL。
-- =============================================================================
