# 应付「接收 → 对账」可见性与对账明细（2026-09-16）

> 用户反馈（原文四条）：
> 1. 「财务板块，应付管理，原料入库条目，某条条目我点击接受应付，为什么没有在待创建对账中看见这条条目」
> 2. 「待创建对账中，对某条条目创建对账单之后，待创建对账就不该继续展示这条条目了。」
> 3. 「已创建对账单，双击某个条目，弹出的表单还应当显示这个订单的物料名称和规格型号」
> 4. 「确认应付中的付款部分，支持折叠收纳」

## 1. 排查结论（逐条）

### 1.1 「点了接收应付，看不到这条条目」= 三件事叠在一起

| # | 根因 | 证据 | 后果 |
| --- | --- | --- | --- |
| A | **接收应付只建应付条目，从不推进来源状态** | `supplier-payable.service.ts` 的 `createFromSource()` 只写 `supplier_payable_entries`；全库没有任何一处把 `payable_sources.status` 从 `pending_finance` 改成已接收（`finance-status.ts` 里的 `SOURCE_LABELS.received = 已接收` 是**死代码**） | 「原料入库条目」永远显示「接收应付」、来源状态永远「待财务接收」，流转看板①「待接收来源 N 条」永远不下降 |
| B | **重复接收是**静默**幂等** | `createFromSource()` 命中 `findUnique(payableSourceId)` 时直接返回旧条目，界面照样 toast「已接收…下一步去对账」 | 用户点了第二次（列表上按钮一直有）时什么都没发生，却看到成功提示 —— 这就是「点了没反应 / 没流转过去」的直接来源 |
| C | **待创建对账是「供应商 + 月份」汇总行** | `pendingGroups` 把草稿按 `${supplierId}|${month}` 聚合，行上只有「N 条」 | 新接收的那条如果落进已有分组，只是让计数 +1；用户要看的**那一条**（单号/来源批次/物料）根本不在表里 |

### 1.2 「创建对账单后待创建对账还显示这条」= 前端不知道草稿是否已被覆盖

`pendingEntries` 只看 `status === "draft"`。而「哪些应付属于这张对账单」由 `SupplierPayableReconciliationService.entryScope()`
定义（供应商 + 币种 + 期间，可再收窄到订单/采购单），前端拿不到 `purchaseOrderId`，自己推不出来，
于是创建完对账后同一条草稿仍然留在「待创建对账」里，用户会重复建单。

### 1.3 「详情看不到物料名称与规格型号」= 摘要与明细都少了规格

- 列表 `flow` 只有 `material_names`；`get()` 的 `details.payable_entries` 也只有 `material_name`；
- 物料主数据的 `specificationModel` 在应付侧两处查询里都没 select（采购侧列表早就有）。

### 1.4 「付款部分要能折叠」= 纯前端（缺一个收纳开关）

「确认应付」下半张付款表没有收纳入口；仓库里已有现成的 `useCollapsiblePanel`（生产单详情用过，
状态记 localStorage）。

## 2. 本次改动

### 2.1 API

- **`supplier-payable.domain.ts` 新增纯函数** `payableInReconciliationScope(entry, scope)` 与
  `coveringPayableReconciliation(entry, scopes)`：这是「一条应付属于哪张对账」的**唯一定义**。
  `SupplierPayableReconciliationService.entryScope()/inScope()` 改为复用它（原来 where 与内存过滤
  各写一遍），应付台账的覆盖判断也用它 —— 三处口径不可能再漂移。
- **接收应付推进来源状态**（`markSourceReceived`）：事务内把 `payable_sources` /
  `outsource_payable_sources` 置为 `received`（`status != voided` 才改，作废是终态；重复调用幂等）。
  这是「接收」这一步唯一改来源状态的地方。
- **`PayableSource` 列表带出已生成的应付单**（`payable_entry: { id, payableNo, status }`，原料入库与
  外加工两条来源都加）：界面据此显示「已接收 → 应付单 AP-xxx（草稿/已确认）」，而不是永远摆一个按钮。
  历史数据（状态还停在 `pending_finance` 但条目已存在）靠这个关联同样不会再提示接收。
- **`SupplierPayableService.list()` 给每条应付标出覆盖它的对账单**
  `reconciliation: { id, reconciliation_no, status, period_start, period_end } | null`：
  一次 `findMany({ supplierId: { in: […] } })` 取回涉及供应商的对账单后在内存里按同一纯函数匹配
  （不做 N+1，也不全表扫）。
- **对账明细与摘要补规格型号**：`flow` 新增 `material_specifications`（与 `material_names` 同序去重）；
  `details.payable_entries[]` 新增 `material_specification`；两处 select 补
  `material.specificationModel`，并保留 `materialSnapshot` 兜底（物料被软删除后仍显示得出）。
- **`get()` 也返回 `flow`**：列表与详情用同一份摘要字段，前端不必为「详情显示什么」再维护一套口径。

### 2.2 前端（`components/finance/payable-workspace.tsx`）

- **「待创建对账」改成逐条列出**未被任何对账单覆盖的草稿应付，列：供应商 / 应付单号 / 待对账月份 /
  来源批次 / 订单号 / 采购单号 / 采购物料 / **规格型号** / 应付金额 / 确认日期 / 操作；
  标题右侧给出「N 条 / 合计 X」。行内「创建对账」仍按该条的**供应商 + 月份**建单（一张对账单覆盖该
  供应商该月全部待确认应付，这是服务端 `entryScope` 的语义），成功后这些条目移到「已创建对账单」。
- **已被覆盖的草稿点名说明**：`payable-covered-drafts` 提示「另有 N 条草稿已纳入对账单、不在此重复对账：
  AP-xxx（APREC-yyy，可在对账单行内一键确认 / 需先处理差异）」。**不能让它不声不响地消失** —— 用户
  反馈的第 1 条正是「看不见这条条目」。
- **来源行显示去向**：已接收的来源状态显示「已接收」、操作列显示「应付单 AP-xxx（状态）」；未接收才给
  「接收应付」按钮。流转看板①只数**没有**应付单的来源（历史数据也能兜住）。
- **接收结果如实回报**：`submitAction` 的 success 支持传函数。接收后按返回条目是否已在本页台账里区分
  「已接收为应付草稿 AP-xxx；下一步：到「应付对账」…」与「该来源此前已接收（AP-xxx / 状态），
  未重复创建；已纳入对账单 APREC-yyy」。
- **对账详情**：字段区新增「采购物料」「规格型号」（读 `flow`），明细表「纳入对账的应付条目」新增
  「规格型号」列（读 `details.payable_entries[].material_specification`）；对账列表也新增「规格型号」列。
- **付款可折叠收纳**：`useCollapsiblePanel("payable-payments")` + `.subsection-heading`
  （标题与开关同排，**按钮放在 h3 外面**，否则 `<h3>` 的可访问名会变成「付款 收起」，
  按标题定位面板的测试与脚本都会失准）。收起时连说明与表格一起隐藏，选择记本机。

## 3. 决策记录

- **D1：来源状态由后端推进，界面再用关联兜底**。两件事都做：`received` 让数据模型自证；
  `payable_entry` 关联让**历史数据**（升级前接收过、状态没改的行）也不再被重复提示接收。
  只改状态会让老数据继续撒谎，只加关联则模型仍然停在「待接收」。
- **D2：覆盖判断放服务端**。对账范围含 `purchaseOrderId`，前端没有这个字段；让前端自己推一遍必然与
  服务端不一致。服务端还额外返回 `reconciliation_no`，界面才能直接告诉用户「它进了哪张单」。
- **D3：不隐藏、只转移**。「已纳入对账」的草稿从待创建对账移出，但必须在同页点名（单号 + 对账单号 +
  下一步能不能确认）。财务对账最怕的是「账不见了」，不是「表长了」。
- **D4：待创建对账逐条而不是分组**。分组的唯一好处是「一次给一个供应商一个月建单」，而那正是行内按钮
  已经在做的事（按钮自带供应商 + 月份）；分组却让「这条条目在不在」不可回答。粒度选择服从用户的问题。
- **D5：对账范围保持「供应商 + 币种 + 期间（可收窄订单/采购单）」不变**。因此一张对账单覆盖的是
  **活的范围**：之后同供应商同期间新接收的草稿也落在它的范围内（并会重新出现「确认 N 条应付」，
  因为 `flow` 每次实时算）。这是既有语义，本次只是把它在界面上说清楚。

## 4. 验证

- API 单测 **1163 / 1163**（本新增 10 条：覆盖口径纯函数 3 条、列表覆盖标记 1 条、来源标记已接收 2 条、
  flow 规格型号 1 条 + 空结构 1 条、详情 flow 与规格 1 条、已接收来源重复接收 1 条）。
- web 组件 **34 文件 / 642 用例**、lib **143 条**、`tsc --noEmit`（api + web）全绿。
- **未执行**：`prisma migrate deploy`（本机无 PostgreSQL，本轮也没有 schema 变更）、`test:integration`、
  Playwright、`next build`（本机 V8 抖动，见当日 log）。

## 5. 已知未做 / 风险

- **应收侧存在同型的「已覆盖」问题**：`receivable-workspace.tsx` 的「待创建对账」同样只看
  `status === "draft"`，创建应收对账单后也会继续展示。本次按用户反馈只改了应付侧；应收侧要对齐需要
  一个 `coveringReceivableReconciliation`（客户 + 币种 + 期间）与 `receivable.service` 的列表增强。
- **升级前已接收的来源不会被回填 `status = received`**（迁移脚本不在本轮范围：「先不用管历史数据」），
  界面靠 `payable_entry` 关联显示正确；若将来有报表直接读 `payable_sources.status`，需要一次性回填。
- **一张对账单的 `period + supplier + currency` 现在可以重复建单**（没有唯一约束）：两条对账范围重叠时，
  同一条草稿会同时属于两张对账单、也可能被先后确认两次。本次没有加约束（业务上会计期间是否允许重复
  要业务确认），但界面上「已纳入对账单 APREC-yyy」会把重叠暴露出来。
