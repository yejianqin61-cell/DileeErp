# 0821-03-02 测试用户、业务夹具与数据隔离

## 状态

待认领

## 认领

负责人：
开始日期：

## 目标

提供可复用且不污染生产数据的测试用户、业务对象工厂、测试数据库隔离和清理机制。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 5 节
- `.agent/constitution/constitution.md`
- `apps/api/prisma/schema.prisma`

## 范围

- 建立销售、采购、仓库/QC、财务、管理员测试角色和独立会话工厂；
- 实现 `createCustomer`、`createConfirmedSalesOrder`、`createPublishedBom`、`createMaterialAndUnit`、`createSupplier`、`createPurchaseOrder`、`createReceipt`、`createIncomingInspection`、`createRawMaterialInbound`、`postInbound` 等夹具；
- 使用唯一测试前缀、独立测试数据库或 schema、事务回滚/逆序清理；
- 测试密码、Cookie、真实业务数据和结算信息不得进入仓库或报告。

## 非范围

- 修改生产 seed 逻辑以适配测试；
- 生产数据迁移和脱敏导入；
- 业务 API 新功能。

## 验收与验证

1. 任意集成测试可独立创建和清理自己的订单主线，不依赖测试执行顺序。
2. 夹具通过业务 API 或 Prisma 合法创建初始状态，不制造无来源脏数据。
3. 清理失败会让测试失败并保留可诊断标识，不静默吞错。
4. 并行测试的 `order_no`、单号和用户会话互不冲突。

## 决策记录

测试夹具提供领域级工厂，不允许每个测试复制长 SQL；跨事务场景使用独立数据而非强行共享事务。

## 完成记录

负责人：
完成日期：
验证：
