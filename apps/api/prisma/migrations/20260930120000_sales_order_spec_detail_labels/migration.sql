-- 销售单「细分明细」的自定义列名（2026-09-30）
--
-- 依据：docs/design/sales-order-subpages-and-detail-labels-2026-09-30.md
-- 用户原话：「细分明细那边，可以改成自定义字段名称。」
--
-- 三处取舍，写下来免得后来的人以为是漏了：
--   1. **一个 JSON 列，不是 6 个列**：这 6 个名字纯粹是"印在纸上的显示名"，没有任何业务规则挂在上面
--      （不参与校验、不参与金额/数量计算）。为显示名加 6 列会把这行再推宽 6 格，而默认值在代码里
--      （后端 `SPEC_DETAIL_LABELS` / 前端 `DEFAULT_SPEC_DETAIL_LABELS`，两边有测试钉住同一份）。
--   2. **NOT NULL DEFAULT '{}'**：空对象 = 全部用默认列名，于是读侧不必处理 NULL 与
--      "JSON null / SQL NULL"两种空（Prisma 的 `Json?` 在这一点上有真实的坑）。
--      Postgres 11+ 加带默认值的 NOT NULL 列不重写全表，这条迁移在真实库上是秒级。
--   3. **按单存，不做全局字典**：同一张单的不同分组列名本来就不同（模板样本 <DL260001-1> 的
--      「伞布明细」与「伞头配色」两块表头就不一样），用户要的是"这一单按我写的印"。
--      逐分组各存一套是下一步的事，见设计文档「不做」一节。
--
-- 不建索引：这个列只按 id 随行读，从不作为查询条件。

ALTER TABLE "sales_orders"
  ADD COLUMN "spec_detail_labels" JSONB NOT NULL DEFAULT '{}';
