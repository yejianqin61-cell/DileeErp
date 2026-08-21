# 0821-03-07 采购链路回归与验收证据

## 状态

已实现（环境阻断）

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

为已完成的 `BOM -> 采购 -> 来料 QC -> 原料入库 -> 应付来源` 建立一条可重复执行的链路回归套件，并产出可审计测试结果。

## 关联决策

- `docs/design/testing-system-and-tooling-plan.md` 第 8 节
- `docs/design/bom-procurement-inbound-qc-payable-chain-implementation-design.md`
- `docs/task/0821-02/08-procurement-inbound-chain-acceptance.md`
- `docs/task/0821-03/03-business-invariants-and-assertions.md` 至 `06`

## 范围

- 主路径：已确认销售单/BOM -> 手工采购单 -> 两次到货 -> QC 分流 -> 分批原料入库 -> 应付来源；
- 负向：未确认销售单、未发布 BOM、停用基础资料、QC 分流不平、超 QC 入库、无权限、非法状态；
- 回退/幂等：重复过账、库存负数冲销、采购超收告警、入库冲销、审计和订单号追溯；
- 验证采购/BOM 快照、数量/金额、库存事实、应付来源唯一性和审计事件；
- 输出 `docs/test/results/` 结果摘要并关联提交号、环境和遗留风险。

## 非范围

- 财务应付确认、付款和核销；
- 生产领料、成品出库和应收；
- 性能压测和生产部署。

## 验收与验证

1. 真实数据库和浏览器主路径均通过，且所有事实共享同一 `order_no`。
2. 任何负向路径失败后无部分写入，回退保留原事实。
3. 幂等重试不重复库存、应付来源或金额。
4. 测试结果可由提交号和命令复现；环境阻断单独记录，不能标记链路验收通过。

## 决策记录

以单一订单主线作为最高测试缝隙，避免各模块单独通过却无法证明数据流转。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：已实现真实 PostgreSQL 采购入库过账用例及环境阻断结果记录。`npm run test:unit`，14 tests passed；未配置 `TEST_DATABASE_URL`，故没有将链路标记为真实验收通过。
