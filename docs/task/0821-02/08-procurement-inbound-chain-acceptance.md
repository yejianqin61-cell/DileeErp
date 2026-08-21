# 0821-02-08 采购至应付来源集成验收

## 状态

待认领

## 认领

负责人：
开始日期：

## 目标

通过一个真实端到端验收缝隙验证本纵向链路的数据一致性、权限、可追溯性与回退能力，并记录 PostgreSQL 环境验收结果和遗留风险。

## 关联决策

- `docs/design/bom-procurement-inbound-qc-payable-chain-implementation-design.md`
- `docs/task/0821-02/01-versioned-forms-and-bom-material-details.md`
- `docs/task/0821-02/02-procurement-master-data-and-schema.md`
- `docs/task/0821-02/03-procurement-orders-and-batch-receipts-api.md`
- `docs/task/0821-02/04-incoming-quality-control-api.md`
- `docs/task/0821-02/05-raw-material-inbound-inventory-payable-source.md`
- `docs/task/0821-02/06-reversals-impact-preview-and-alerts.md`
- `docs/task/0821-02/07-procurement-inbound-chain-frontend.md`

## 范围

- 准备已确认销售单、带物料明细 BOM、物料、供应商和单位的可复现测试数据；
- 执行浏览器流程：`order_no -> BOM 版本 -> 采购单 -> 分批到货 -> QC -> 分批原料入库 -> 应付来源草稿`；
- 验证权限、审计、来源追溯、数量累计、条件接收、幂等过账、库存余额与应付来源金额；
- 执行负向与回退场景：草稿销售单采购、QC 分流不平、超 QC 入库、重复过账、库存负数风险、已入库采购直接取消、入库冲销/退货；
- 执行 API/Web build、typecheck、自动化测试、Prisma 迁移与真实 PostgreSQL 验收；记录启动和恢复方式。

## 非范围

- 财务应付确认、付款、核销与对账验收；
- 生产、成品库存、应收与薪资流程；
- 多人性能压测和正式工厂部署。

## 验收与验证

1. 链路每个事实都能回查 `order_no`、销售单、BOM 版本、采购明细、到货批次、QC、入库和应付来源。
2. 分批到货、QC、入库的累计数量正确；可用库存只反映 QC 允许且已过账的数量。
3. 一次原料入库只产生一条有效应付来源；重复请求不重复记库存或金额。
4. 全部负向场景不留下部分写入或不可追溯余额；回退通过新事实而不是删除历史。
5. PostgreSQL 真实迁移、seed 和浏览器数据流成功；若环境仍阻断，明确记录阻断原因、已完成静态验证及部署前复验命令。
6. 任务完成后更新编码路线图 C1-C6 状态、每日开发日志和测试记录。

## 决策记录

端到端验收以单一订单主线为最高测试缝隙，避免仅凭各页面独立可打开便宣告链路完成。

## 完成记录

负责人：
完成日期：
验证：
