-- 「其他应付」条目上可指定会计科目（2026-10-12）
--
-- 依据：财务反馈「周金红那几行，也就是备用金付款，看不到明细」+ 用户选定
-- 「新建其他应付与批量导入两个入口都加会计科目」。
--
-- 排查结论（见 docs/design/other-payable-detail-and-subject-2026-10-12.md）：
--   · 「其他应付」条目的科目原先**没有任何地方可填** —— 应付条目上没有这一列，
--     新建表单没有这一格，导入模板没有这一列；科目只在
--     「创建应付对账」时整体填一个（SupplierPayableReconciliation.subjectId），
--     或在「登记付款」时填（SupplierPayment.subjectId）。
--   · 于是备用金（62 行）全部走 `PAYMENT_SUBJECT_NAMES.other` 的候选链首位
--     「管理费用」（损益类）。而备用金在财务那张科目表里是**资产类**「库存现金（备用金）」，
--     房租是成本类「房租费」：同一条来源类型（other）分不开它们，只能由录单的人指。
--
-- 三条取舍：
--   · **可空**：历史行全部为 NULL。为 NULL = 没指定，确认应付时仍退回按来源的候选链
--     （`PAYMENT_SUBJECT_NAMES.other`），所以历史行为一字不变。
--   · **外键 RESTRICT**：科目只停用不删除（宪法《Configurable Business Categories》），
--     被引用的科目必须留成历史快照；可空关系在 Prisma 里默认是 SET NULL，
--     那会让「删科目」把历史单据上的科目悄悄抹成空 —— 所以 `schema.prisma` 的
--     `subject` 关系上**必须写 `onDelete: Restrict`**，与这里的 DDL 逐字对齐。
--     （注意：`supplier_payments.subject_id` / `supplier_payable_reconciliations.subject_id`
--     走的是 Prisma 默认的 SET NULL，与这里**不同形**，不要照抄那两处的 schema 写法。）
--     配套：`AccountingSubjectService.usageCount()` 必须把这一列也数进去，
--     否则财务删一个只被其他应付引用的科目会撞数据库约束（报错她看不懂）。
--   · **纯加列 + 建外键 + 建索引**：PostgreSQL 只改目录，不重写表。
--     索引也要写进 `schema.prisma` 的 `@@index([subjectId])`，否则两边永久漂移
--     （本仓库的迁移是手写 SQL、不走 `prisma migrate dev` 生成，漂移不会被工具报出来）。
--
-- 部署顺序仍是先 `prisma migrate deploy`，再发代码（前后端一起）：
-- 新前端保存「新建其他应付」时会带上这一列，列不存在会直接报错。

ALTER TABLE "supplier_payable_entries" ADD COLUMN "subject_id" UUID;

ALTER TABLE "supplier_payable_entries"
  ADD CONSTRAINT "supplier_payable_entries_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "supplier_payable_entries_subject_id_idx" ON "supplier_payable_entries"("subject_id");
