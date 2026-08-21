# 0821-01-05 BOM 来源与版本后端 API

## 状态

已完成（PostgreSQL 集成验证待环境恢复）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

实现从已确认销售单创建和查询 BOM 的最小后端闭环，固定 BOM 的订单和销售版本来源，但不提前固化物控明细。

## 关联决策

- `docs/design/0821-01-initial-order-chain-delivery-plan.md`
- `docs/design/product-modeling-completion-and-coding-baseline.md`
- `docs/design/sales-module-design.md`

## 范围

- BOM 列表、详情、从销售单创建、版本查询及来源链路查询 API；
- 仅允许已确认销售单作为 BOM 来源；保存 `order_no`、销售单 ID、销售单版本、BOM 版本和扩展定义版本；
- 支持同一订单按规则创建多个 BOM 版本，保留所有历史来源；
- 为销售编辑影响预览提供 BOM 引用查询；
- 事务、审计、状态记录和稳定错误码。

## 非范围

- BOM 物料行、损耗、工艺、采购建议、成本计算；
- QC、采购单、库存和生产单；
- 物控的独立权限模块。

## 验收与验证

1. 草稿或不存在的销售单创建 BOM 返回 `422 SALES_ORDER_NOT_CONFIRMED` 或 `404`。
2. BOM 详情可追溯订单号和创建时的销售版本。
3. 销售单后续变更不会自动改写既有 BOM；查询可返回复核差异所需来源版本。
4. 同一订单的多个 BOM 版本均保留审计和来源关系。
5. 未确认的 BOM/QC 业务字段未被硬编码为固定表列。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：完成 BOM 列表/详情、已确认销售单来源创建、版本递增、销售版本保存、扩展数据编辑和审计；API build/typecheck 通过。真实 PostgreSQL 集成验证待数据库环境恢复。
