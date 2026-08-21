# 0821-01-02 销售域基础与数据库 Schema

## 状态

待认领

## 认领

负责人：
开始日期：

## 目标

建立客户、销售单、版本、BOM 核心来源关系和销售权限键的最小 PostgreSQL Schema，为订单主线 API 提供稳定持久化基础。

## 关联决策

- `docs/design/0821-01-initial-order-chain-delivery-plan.md`
- `docs/design/product-modeling-completion-and-coding-baseline.md`
- `docs/design/global-api-contract.md`
- `docs/design/sales-module-design.md`

## 范围

- 将临时 `customers` 模块权限和目录迁移为 `sales` 领域归属，并更新所有引用；
- 建立客户及客户联系人的 UUID、审计、软删除、停用、唯一名称/代码和销售单快照关系；
- 建立销售单的固定核心、`order_no` 唯一约束、版本、状态记录引用、扩展字段定义版本引用与结构化值；
- 建立 BOM 最小核心：订单号、销售单/销售版本来源、BOM 版本、状态、扩展字段定义版本引用和结构化值；
- 通过数据库外键、唯一索引和检查约束保护不可绕过的核心关系；
- 编写可重复的 Prisma 迁移和最小测试数据工厂/初始化辅助。

## 非范围

- BOM 物料明细、工艺字段、QC 项目和采购数据；
- 销售单 Excel/PDF 导出和附件业务界面；
- 业务 API 和前端页面。

## 验收与验证

1. 空 PostgreSQL 可应用迁移，重复应用不失败。
2. 客户名称、客户代码及有效销售单 `order_no` 的唯一性由数据库保证。
3. 所有业务表具有约定的 UUID、审计和软删除字段。
4. 销售单与 BOM 能保存清晰的 `order_no`、来源实体 ID 和来源版本，不依赖 JSON 作为核心关系。
5. BOM/QC 未确认明细字段不被提前硬编码，扩展值仍可保留历史定义版本。

## 决策记录

客户池、销售单和 BOM 均归属 `sales` 领域模块；物控通过该模块权限维护 BOM，直至未来有确认的独立物控权限模型。

## 完成记录

负责人：
完成日期：
验证：
