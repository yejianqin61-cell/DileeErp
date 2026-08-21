# 0821-02-04 来料 QC 与数量分流后端 API

## 状态

已完成

## 认领

负责人：Codex
开始日期：2026-08-21

## 目标

在每次采购到货上建立可追溯的来料 QC 门禁，准确分流合格、条件接收和不合格数量，禁止未经 QC 的到货进入可用原料库存。

## 关联决策

- `docs/design/bom-procurement-inbound-qc-payable-chain-implementation-design.md`
- `docs/design/warehouse-module-design.md`
- `docs/task/0821-02/03-procurement-orders-and-batch-receipts-api.md`

## 范围

- 实现 QC 待检列表、详情、创建/草稿编辑、提交、接受、条件接收、拒绝等显式状态动作；
- 为 QC 保存到货批次、订单号、送检数量、合格/条件接收/不合格数量、检验人、时间、附件和扩展检验数据定义版本；
- 原子校验 `accepted_quantity + conditional_quantity + rejected_quantity = inspected_quantity`，并确保总检验数量不超过可检验到货数量；
- 更新到货与采购明细的 QC 派生进度，不可由客户端覆盖累计字段；
- 明确返回可入库数量和结果类型，供原料入库任务执行仓库确认；
- 应用 `warehouse` 权限、审计、状态机和统一错误契约。

## 非范围

- QC 检验项目、抽检方案和判定阈值的最终模板；
- 原料入库、退供应商、库存余额及应付来源；
- 成品 QC。

## 验收与验证

1. 每个 QC 记录可追溯到单一到货批次、采购明细和 `order_no`。
2. 分流合计不等于送检数量、负数或超过可检验数量时返回 `422 INSPECTION_QUANTITY_MISMATCH`，不写入部分结果。
3. 到货完成不等于 QC 合格；QC 结论本身不增加可用库存。
4. 合格与条件接收必须保留不同结果类型；不合格数量不可进入可用原料路径。
5. API/领域测试覆盖分批检验、状态冲突、权限与审计。

## 决策记录

条件接收不是普通合格的别名。它可以在后续仓库明确确认后入库，但必须保留原始 QC 类型。

## 完成记录

负责人：Codex
完成日期：2026-08-21
验证：Prisma format/generate、API build、API typecheck 和 8 项 Node 测试通过；真实 PostgreSQL 集成测试待部署环境执行。
