# 0821-02-02 采购基础资料与持久化 Schema

## 状态

已完成

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

建立物料池、供应商、单位池及采购、到货、QC、原料入库、库存事实和应付来源所需的最小持久化关系与约束，为后续 API 提供不可绕过的数据完整性基础。

## 关联决策

- `docs/design/bom-procurement-inbound-qc-payable-chain-implementation-design.md`
- `docs/design/procurement-module-design.md`
- `docs/design/warehouse-module-design.md`
- `docs/design/global-api-contract.md`

## 范围

- 建立物料、供应商、单位基础资料及启用/停用、唯一性、快照和统一审计字段；单位初始值为打、码、个、包、捆；
- 建立采购单/明细、分批到货、来料 QC、原料入库/明细、库存动态事实/读模型、应付来源草稿的表关系、外键、索引、状态和逻辑删除字段；
- 保护 `order_no`、销售单、BOM ID/版本、采购单号、供应商、物料、数量、单位和来源关系；
- 对应付来源建立来源入库事实唯一约束/幂等键；对派生数量和库存余额限定为服务端/事务维护；
- 编写可重复 Prisma 迁移和测试数据辅助，复用平台审计及软删除能力。

## 非范围

- 基础资料管理 API 或页面；
- 财务应付确认、付款、核销和供应商结算规则；
- 未确认的供应商银行信息、税费算法、仓位和单位换算。

## 验收与验证

1. 空 PostgreSQL 可应用迁移，重复迁移不失败；现有销售/BOM 数据不被破坏。
2. 物料编码/名称、供应商编码/名称和有效采购单号满足设计定义的唯一约束。
3. 所有新增业务表均含 UUID、`created_at`、`updated_at`、`created_by`、`updated_by`、逻辑删除及必要来源外键。
4. 应付来源不能对同一有效原料入库事实重复建档；库存余额不能作为可由客户端直接更新的业务字段。
5. Prisma schema 校验、Client 生成、API build/typecheck 及数据库约束测试通过；真实 PostgreSQL 验收仍记录为部署环境检查项。

## 决策记录

本任务先锁定不可变的来源和数量关系，不为 BOM/QC 的未确认明细创建刚性列。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：Prisma format/generate、API build、API typecheck 和 8 项 Node 测试通过；真实 PostgreSQL 迁移待部署环境执行。
