# 采购链路测试结果

- 提交：`待 task 07 提交后补充`
- 命令：`npm run db:test:prepare`、`npm run test:integration`
- 环境：本机未配置 `TEST_DATABASE_URL`，且本次不复用任何生产连接串。
- 结果：环境阻断，未执行真实 PostgreSQL 采购链路验收。
- 已实现用例：`procurement.inbound.post_generates_inventory_and_a_single_payable_source`；覆盖同一 `order_no`、入库库存事实、单一应付来源及重复过账拒绝。
- 遗留风险：Docker PostgreSQL 镜像或本地专用测试 PostgreSQL 就绪前，无法证明迁移、真实事务及前端到后端的数据流。
