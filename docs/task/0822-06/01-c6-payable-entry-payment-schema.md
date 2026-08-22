# Task 01：C6 应付确认、付款与核销数据模型

依据 `docs/design/payable-confirmation-payment-allocation-chain-implementation-design.md`，新增 `SupplierPayableEntry`、`SupplierPayment`、`SupplierPaymentAllocation` Prisma 模型和迁移。

要求：两类应付来源可选外键、来源唯一索引、订单/供应商/状态索引、Decimal(18,4)、状态字段、附件、审计字段和软删除字段；不得修改已有来源表。

完成条件：Prisma format/generate、迁移 SQL 和 API 类型检查通过。

