# Task 01：E2 成品入库与不良品数据模型

## 目标

为成品分批入库、不良品记录和库存事实建立 Prisma 模型与迁移。

## 实施要求

- 新增 `FinishedGoodsInbound` 与 `FinishedGoodsDefective`，包含来源 QC、`order_no`、生产单、单位/产品快照、数量、状态、幂等键、软删除和审计字段。
- 为 `InventoryFact` 增加必要的成品来源关系或可空来源字段，保证原料、成品、不良品分类隔离。
- 增加唯一约束、来源查询索引和状态查询索引。
- 运行 Prisma generate、类型检查和迁移 SQL 校验。

## 完成标准

迁移可重复部署，Prisma Client 类型可用，模型不改变既有原料入库行为。
