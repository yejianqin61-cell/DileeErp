# Task 03：应付管理二级页与来源 / 对账 / 确认

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

应付管理拆成四个子栏目（原料入库条目 / 外加工签收 / 应付对账 / 确认应付），并打通
「原料入库过账 / 外加工签收 → 待接收来源 → 接收应付 → 按供应商+期间对账 → 批量确认应付 → 付款核销」链路。

## 背景与问题

- 待接收来源、正式应付、付款分属不同面板，且列表缺少供应商名称；
- 应付对账虽然存在，但 `SupplierPayableEntry.purchaseOrderId` 从未落库，
  导致「按采购单对账」的系统余额恒为 0；
- 对账对平后没有批量确认应付的入口。

## 范围

### 后端

- `GET /finance/payable-entries` 富化：供应商、已付/未付；
- `GET /finance/supplier-payments` 带供应商；
- `GET /finance/supplier-payable-reconciliations/:id` 的 `details` 补草稿应付与待确认汇总；
- 新增 `POST /finance/supplier-payable-reconciliations/:id/confirm-payables`；
- 修复：`createFromSource` 落库 `purchaseOrderId / purchaseOrderItemId / outsourceLogisticsBatchId`。

### 前端

- 原料入库条目 / 外加工签收：来源表格 + 双击详情 + 接收应付（分别带正确的 `source_type`）；
  **只列待接收的来源**（已接收的从列表移出，标题旁用「待接收 N 条 · 已接收 M 条」点名，2026-09-16 二次改）；
- 应付对账：待创建对账**逐条**列出未被任何对账单覆盖的草稿（供应商/单号/月份/来源批次/订单号/采购单号/
  物料/规格型号/金额）+ 已覆盖条目的点名说明 + 对账单 + 处理差异 / 一键确认应付（2026-09-16 由分组改成逐条）；
- 确认应付：台账视角表格（含草稿）+ **勾选 + 批量确认**（整批一个支付银行 + 一个收支项目，
  每条应付各写一条支出流水）；**不再有**「登记付款 → 过账核销」这第二步 —— 确认即记账，
  再登记一次付款就是把同一笔钱扣两次（2026-09-16 二次改，见
  [Task 11](11-batch-confirm-and-copy-trim.md)）。

## 不做

- 不单独做「采购到货」子栏目（业务确认）：后端明确禁用到货单作为可接收应付来源
  （`PURCHASE_RECEIPT_PAYABLE_DISABLED`，应付来源只由原料入库过账产生）；
- 不实现供应商门户、发票验真、银行直连。

## 验收与验证

1. 原料入库条目只列原料入库来源，历史 `purchase_receipt` 来源不混入（组件测试）；
2. 外加工签收单独成栏，接收时 `source_type = outsource_receipt`；
3. 应付对账对平后可一键确认；`difference` 被拒绝；来源已作废的草稿被跳过并回报；
4. 付款核销带 `allocations`，超范围由后端拒绝；
5. 双击应付来源行不发起 `:id` 请求（后端没有该端点），用行数据渲染详情。

## 决策记录

- 「确认应付」列**全部状态**：接收来源产生的草稿必须有地方可以逐条确认，
  否则「先对账再确认应付」会成为唯一入口，单条确认无从操作；
- 批量确认时 `voided` 来源的草稿**跳过并回报**而不是整批失败：上游冲销是合法业务事实，
  不应该阻塞同一对账单里其他正常条目的确认；
- 修复采购单关联落库而不是在查询侧绕过：对账按 `purchase_order_id` 过滤是既定口径，
  缺字段属于写入缺陷，改查询只会掩盖问题。

## 完成记录

- `supplier-payable-reconciliation.service.ts` 重写（entryScope / 草稿明细 / confirmPayables）；
- `supplier-payable.service.ts` 列表富化 + 关联落库修复；
- `supplier-payment.service.ts` 列表带供应商；
- `finance.controller.ts` 新端点；
- 单测新增 5 条（批量确认 3、创建关联 2），并修好 1 条因新增字段而失效的列表用例。
- 验证结果：api typecheck 通过；`test:unit:api` 908/908 通过；web 端应付相关用例通过。
- 2026-09-16 增补（用户反馈四条，见 `docs/design/payable-pending-reconciliation-2026-09-16.md`）：
  接收应付推进来源状态为 `received` + 来源列表带 `payable_entry`；`SupplierPayableService.list()` 标出
  覆盖每条应付的对账单；待创建对账改逐条 + 覆盖点名；对账 flow/明细补规格型号、`get()` 补 `flow`；
  付款段可折叠。API 单测至 1163、web 组件 642。
