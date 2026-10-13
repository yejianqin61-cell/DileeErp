-- 收支流水的「收支类目」（2026-10-13）
--
-- 依据：用户原话「财务部分，收支明细表，也要显示收支类目。比如说采购某个物料，
-- 或者其他应付其他应收也要带上会计科目。而且导出的 excel 也要显示相应的 column。」
--
-- 排查结论（见 docs/design/cash-flow-category-and-payable-batch-delete-2026-10-13.md）：
--   · 流水上原有的 `subject_id` 是**销账那条现金分录的对方科目**：已挂账的付款一律是「应付账款」、
--     收款一律是「应收账款」。它回答的是"这笔现金分录的另一头是谁"，回答不了"这笔钱花在什么上"。
--   · 「这笔钱算什么」这件事在来源单据上是有的：其他应付的条目（2026-10-12 加的 `subject_id`）、
--     覆盖它的应付/应收对账单的 `subject_id`；采购/外加工没有就按来源类型的候选链（原材料/加工费）。
--   · 用户选定：**不动账、另加一列**（把原列改成类目会让「从流水生成凭证」把成本重复记一次）。
--
-- 三条取舍：
--   · **可空**：历史行全部为 NULL，报表那一格显示为空（手工流水本来也只有主科目，见设计文档 1.3）。
--   · **外键 SET NULL**（不是像 `supplier_payable_entries.subject_id` 那样的 RESTRICT）：这一列是
--     展示用的业务分类，不是记账依据 —— 删科目不该被它挡住，也不进 usageCount()。
--     与 `supplier_payments.subject_id` / `supplier_payable_reconciliations.subject_id` 同形。
--     ⚠️ Prisma 里可空关系默认就是 SET NULL，但 `schema.prisma` 仍然显式写出 `onDelete: SetNull`，
--     免得以后有人照抄 20261013090000 那条 RESTRICT 的写法把两边改漂移。
--   · **纯加列 + 建外键 + 建索引**：PostgreSQL 只改目录，不重写表。

ALTER TABLE "cash_flow_entries" ADD COLUMN "category_subject_id" UUID;

ALTER TABLE "cash_flow_entries"
  ADD CONSTRAINT "cash_flow_entries_category_subject_id_fkey"
  FOREIGN KEY ("category_subject_id") REFERENCES "accounting_subjects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "cash_flow_entries_category_subject_id_idx" ON "cash_flow_entries"("category_subject_id");
