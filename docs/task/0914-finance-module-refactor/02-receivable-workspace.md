# Task 02：应收管理二级页与客户 + 期间对账

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

应收管理拆成三个子栏目（成品出库条目 / 应收对账 / 确认应收），并打通
「成品出库 → 应收来源 → 按客户+期间对账 → 确认应收（勾选批量确认，确认即记账）」链路。

## 背景与问题

- 成品出库过账本来就创建 `ReceivableSource` 草稿，但财务列表只给 UUID，看不出客户与出库单；
- 应收对账必须挂单个订单号，与财务「按客户按月对账」的实际做法不符；
- 「先对账、再确认应收」没有对应动作：对账对平后没有任何批量确认入口。

## 范围

### 后端

- `GET /finance/receivable-sources` 富化：客户、出库单、产品、已收/未收；
- `GET /finance/reconciliations` 带客户；`GET /:id` 带纳入对账的条目明细与待确认汇总；
- `POST /finance/reconciliations` 支持 `customer_id` + 期间（`order_no` 变为可选）；
- 新增 `POST /finance/reconciliations/:id/confirm-receivables`；
- 迁移：`receivable_reconciliations.order_no` 改可空。

### 前端

- 成品出库条目：来源视角表格 + 双击详情 + 草稿的确认/编辑/取消、已确认的回退；
- 应收对账：待创建对账**逐条**列出未被任何对账单覆盖的草稿（客户/来源编号/月份/订单号/出库单/
  产品/规格型号/金额）+ 已覆盖条目的点名说明 + 对账单表格（含订单号/产品/规格型号/待确认应收）
  + 处理差异 / 一键确认应收（2026-09-16 由「客户 × 月份分组」改成逐条）；
- 确认应收：台账视角表格 + **勾选 + 批量确认**（整批一个入账银行 + 一个收支项目，
  每条应收各写一条收入流水）；**不再有**「登记收款 → 过账核销」这第二步、也不再有
  「按订单批量确认」那张表 —— 确认即记账，再登记一次收款就是把同一笔款进两次
  （2026-09-16 二次改，见 [Task 11](11-batch-confirm-and-copy-trim.md)）。

## 不做

- 不实现发票开具、税务计算、客户预收款；
- 不做对账明细的冻结快照（见设计的「未决事项」）。

## 验收与验证

1. 成品出库过账后能在「成品出库条目」看到草稿并确认；
2. 双击任意行弹出居中详情，展示全部字段与可用操作，且详情从 `:id` 接口取；
3. 对账按客户 + 期间创建，表单自动带入客户与期间；
4. `matched` / `resolved` 才允许一键批量确认；`difference` 被拒绝（单测断言零写入）；
5. 收款登记、核销（带 `allocations`）、冲销都打到正确端点（**2026-09-16 起界面上没有这三个入口**：
   确认即记账，接口与单测保留）。

## 决策记录

- 「确认应收」列**全部状态**而不是只列已确认：否则「成品出库条目 → 逐条确认」没有入口，
  单条有异议的出库单无法单独处理（只能通过对账批量确认）；
- 对账快照（应收/已收/调整/系统余额）在创建时固化；「纳入对账的条目」是实时查询的工作集，
  用于展示与批量确认。要冻结明细需新增快照列，属未决事项；
- 批量确认逐条 `SELECT … FOR UPDATE`，与单条确认一致，避免与收款核销并发时状态错乱。

## 完成记录

- `reconciliation.service.ts` 重写（scopeWhere / entries / confirmReceivables）；
- `receivable.service.ts` 列表与详情富化；`customer-payment.service.ts` 列表富化；
- `finance.controller.ts` 更新 DTO + 新端点；
- 迁移 `20260914180000_receivable_reconciliation_customer_period` + 守卫测试；
- 单测新增 8 条（对账客户+期间 4、批量确认 4）。
- 验证结果：api typecheck 通过；`test:unit:api` 908/908 通过；web 端 21 条财务用例通过。**未在真实库验证迁移。**
- 2026-09-16 增补（与应付侧对齐，用户要求「应收侧对应的问题也都改」，见
  `docs/design/payable-pending-reconciliation-2026-09-16.md` 第 5 节）：`receivable.domain.ts` 新增
  对账覆盖口径纯函数；`ReceivableService.list()` 标出覆盖每条应收的对账单；`ReconciliationService`
  的 `list()`/`get()` 返回 `flow`（覆盖条数 / 待确认 / 订单号 / 产品名称 / 规格型号），`entries()`
  补 `product_name` / `product_specification`；待创建对账改逐条 + 覆盖点名；一键确认应收改看
  `can_confirm_receivables`（范围内没有草稿时只给说明）；收款面板可折叠。API 单测至 1170、
  web 组件 646。
