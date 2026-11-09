# 财务前端

> 范围：`apps/web/app/finance/**`、`apps/web/components/finance/**`、`apps/web/lib/*finance*`、`apps/web/lib/accounting-subjects.ts`、`apps/web/lib/voucher-lines.ts`、`apps/web/lib/finance-slip.ts`。只读分析，未改任何源码。
>
> 请求前缀：前端所有接口都走 `api-client.ts` 拼 `/api/v1`（`apps/web/lib/api-client.ts:17`、`:32`），`/api/v1/*` 由 Next rewrite 转发到 API（`apps/web/next.config.ts:11`）；web 侧没有 `app/api` 代理目录。下文路径均为 `/api/v1` 之后的部分。
>
> 口径基准：`/finance/payable`、`/finance/cash-flow`、`/finance/voucher`、`/finance/cash-flow?tab=subjects` 四个页面（2026-11-07 当前代码）；同时对照后端契约核验前端承诺（`cash-flow.controller.ts`、`supplier-payable.service.ts`、`voucher.service.ts`）。

## 1 页面与接口映射表

### 1.1 财务板块清单

一级页 `/finance` 只有 9 个板块入口（`apps/web/lib/finance-sections.ts:10-23`，渲染于 `apps/web/components/finance/finance-board-index.tsx:14-23`）：

| 板块 | 地址 | 子栏目（tab） |
| --- | --- | --- |
| 应收管理 | `/finance/receivable` | 成品出库条目 / 应收对账与确认（`finance-sections.ts:28-31`） |
| 应付管理 | `/finance/payable` | 原料入库条目 / 外加工签收 / 应付对账与确认（`finance-sections.ts:34-38`） |
| 工资管理 | `/finance/salary` | 工资台账 `/finance/salary/ledger`、工资付款 `/finance/salary/payments`（`finance-sections.ts:164-167`） |
| 收付款单 | `/finance/slips?kind=payment` 或 `?kind=receipt` | 无（单据存档页） |
| 银行账户 | `/finance/banks` | 无 |
| 银行余额互转 | `/finance/bank-transfers` | 无 |
| 收支管理 | `/finance/cash-flow` | 收支流水 / 会计科目（`finance-sections.ts:146-149`） |
| 财务报表 | `/finance/reports` | 12 张表（`finance-sections.ts:106-128`） |
| 凭证管理 | `/finance/voucher` | 无（`finance-sections.ts:157`） |

### 1.2 应付管理（`/finance/payable`）

页面加载（三个 tab 共用一次 `Promise.all`）：`GET /payable-sources`、`GET /production/outsource-logistics-batches/payable-sources`、`GET /finance/payable-entries`、`GET /finance/supplier-payable-reconciliations`、`GET /suppliers`、`GET /sales-orders`、`GET /finance/banks`、`GET /finance/accounting-subjects?include_inactive=true` —— `apps/web/components/finance/payable-workspace.tsx:378-389`。

| 页面元素 | 接口 | 写入字段 | file:line |
| --- | --- | --- | --- |
| 原料入库「接收应付」 | `POST /finance/payable-entries/from-source` | `source_type, source_id, amount, amount_reason, confirmation_date, remark` | `payable-workspace.tsx:580-588` |
| 外加工签收「接收应付」 | 同上（`source_type=outsource_receipt`） | 同上 | `payable-workspace.tsx:580-588`、`:1026` |
| 确认应付台账「编辑」 | `PATCH /finance/payable-entries/:id` | `amount, currency, confirmation_date, remark`（**不含会计科目**） | `payable-workspace.tsx:590-596` |
| 逐条「确认应付」 | `POST /finance/payable-entries/:id/confirm` | `bank_id, subject_id` | `payable-workspace.tsx:708-724` |
| 批量「确认」 | `POST /finance/payable-entries/batch-confirm` | `ids, bank_id, subject_id` | `payable-workspace.tsx:734-756` |
| 对账单行「确认 N 条应付」 | `POST /finance/supplier-payable-reconciliations/:id/confirm-payables` | `bank_id, subject_id` | `payable-workspace.tsx:866-889` |
| 「新建其他应付」 | `POST /finance/payable-entries/other` | `supplier_id, amount, currency, description, subject_id, confirmation_date, remark` | `payable-workspace.tsx:829-840` |
| 「创建应付对账」 | `POST /finance/supplier-payable-reconciliations` | `supplier_id, order_no, period_start, period_end, external_balance, currency, bank_id, subject_id, remark` | `payable-workspace.tsx:842-855` |
| 「处理差异」 | `PATCH /finance/supplier-payable-reconciliations/:id/resolve` | `resolution_remark` | `payable-workspace.tsx:856-858` |
| 「回退」/「冲销应付」 | `POST /finance/payable-entries/:id/reopen` / `/:id/reverse` | `reason` | `payable-workspace.tsx:598-603`、`:1231-1232` |
| 删除其他应付 / 删除对账单 | `DELETE /finance/payable-entries/:id`、`DELETE /finance/supplier-payable-reconciliations/:id` | `reason` | `payable-workspace.tsx:616-620`、`:629-633` |
| 批量删除其他应付 | `POST /finance/payable-entries/batch-delete` | `ids, reason` | `payable-workspace.tsx:655-672` |
| 批量导入其他应付 | `POST /finance/payable-entries/import`（multipart） | xlsx 文件 | `payable-workspace.tsx:806-827` |
| 「付款单」/「集中付款单」预填 | `POST /finance/payment-slips/draft` | `ids`（`financeSlipDraftBody`） | `payable-workspace.tsx:687-697`、`apps/web/lib/finance-slip.ts:167-168` |
| 付款单「保存这一张」 | `POST /finance/slips` / `PATCH /finance/slips/:id` | 表头 `slip_no, slip_date, slip_method, counterparty_name, our_bank_name, our_bank_account, counterparty_bank_name, counterparty_bank_account, currency, exchange_rate, amount_cny, attachment_count, remark` + 行 `summary, general_subject, detail_subject, debit, credit, remark` | `apps/web/components/finance/finance-slip-editor.tsx:219-226`、`finance-slip-editor.tsx:312-331` |
| 付款单导出 | `POST /finance/payment-slips.xlsx`、`POST /finance/payment-slips/batch.xlsx`（裸 fetch，路径自带 `/api/v1` 前缀） | 同一份单据体 | `apps/web/lib/finance-slip.ts:179-181`、`:190-192`；`finance-slip-editor.tsx:242`、`:263` |
| 「合并付款」建单 | `POST /finance/supplier-payments` | `supplier_id, payment_date, amount, currency, payment_method, bank_id, idempotency_key, order_no?, subject_id?, remark?` | `apps/web/components/finance/payable-merge-payment-dialog.tsx:207-222` |
| 「合并付款」过账核销 | `POST /finance/supplier-payments/:id/post` | `allocations[].payable_entry_id, amount` | `payable-merge-payment-dialog.tsx:205`、`:236` |

### 1.3 收支管理（`/finance/cash-flow`）

| 页面元素 | 接口 | 写入字段 | file:line |
| --- | --- | --- | --- |
| 流水列表 + 筛选 | `GET /finance/cash-flow-entries?from&to&subject_id&category&currency&direction&include_reversed` | —— | `apps/web/components/finance/cash-flow-workspace.tsx:185-194` |
| 科目下拉 / 分类下拉数据源 | `GET /finance/accounting-subjects?include_inactive=true` | —— | `cash-flow-workspace.tsx:196` |
| 结算账户下拉 | `GET /dictionaries/settlement_account/items` | —— | `cash-flow-workspace.tsx:197`；字典 key 见 `finance-sections.ts:154` |
| 银行账户下拉 | `GET /finance/banks` | —— | `cash-flow-workspace.tsx:200` |
| 「新增流水」 | `POST /finance/cash-flow-entries` | `entry_date, counterparty_name, direction, amount, currency, subject_id, settlement_method, settlement_account_id, bank_id, payment_nature, order_no, remark` | `cash-flow-workspace.tsx:317-331` |
| 「更正」 | `PATCH /finance/cash-flow-entries/:id` | 同上；会计科目按行来源送 `category_subject_id` 或 `subject_id`；`order_no` 显式送空串 | `cash-flow-workspace.tsx:334-350` |
| 「冲销」 | `POST /finance/cash-flow-entries/:id/reverse` | `reason` | `cash-flow-workspace.tsx:353-368` |
| 「会计科目」子栏目 | `GET /finance/accounting-subjects?include_inactive=true`、`GET /finance/accounting-subject-categories` | —— | `apps/web/components/finance/accounting-subject-workspace.tsx:68-85`；路径常量 `apps/web/lib/accounting-subjects.ts:21`、`:49` |
| 新增/编辑/停用/删除科目 | `POST /finance/accounting-subjects`、`PATCH /finance/accounting-subjects/:id`、`DELETE /finance/accounting-subjects/:id` | `category, name, balance_direction` / `is_active` | `accounting-subject-workspace.tsx:132-200` |
| 科目类目增删改 | `POST /finance/accounting-subject-categories`、`PATCH/DELETE /finance/accounting-subject-categories/:id` | `name` | `accounting-subject-workspace.tsx:210-261` |
| 建账期初余额（同页） | `GET/PUT /finance/opening-balances` | `as_of_date, currency, rows[]{subject_key, subject_label, direction, amount, remark}` | `apps/web/components/finance/opening-balance-panel.tsx:62-93`；`apps/web/lib/opening-balance.ts:58` |
| 期末汇率（同页） | `GET/PUT /finance/exchange-rates` | `period, rows[]` | `apps/web/components/finance/exchange-rate-panel.tsx:51-74`；`apps/web/lib/exchange-rate.ts:55` |

### 1.4 凭证管理（`/finance/voucher`）

| 页面元素 | 接口 | 写入字段 | file:line |
| --- | --- | --- | --- |
| 页面加载（流水表 + 凭证表 + 科目表） | `GET /finance/cash-flow-entries`、`GET /finance/vouchers`、`GET /finance/accounting-subjects` | —— | `apps/web/components/finance/voucher-workspace.tsx:152-157` |
| 流水行「生成凭证」 | `POST /finance/vouchers/from-cash-flow/:entryId` | 无 body（由流水推导） | `voucher-workspace.tsx:209-223` |
| 「凭证纸」 | `GET /finance/vouchers/:id` | —— | `voucher-workspace.tsx:225-237`、`:438` |
| 「编辑分录」 | `GET /finance/vouchers/:id` 后 `PATCH /finance/vouchers/:id` | `summary, remark, lines[]{direction, subject_key, subject_label, summary, amount, bank_id}`（**无 subject_id**） | `voucher-workspace.tsx:304-310`；`apps/web/components/finance/voucher-line-editor.tsx:149-155`；`apps/web/lib/voucher-lines.ts:163-180` |
| 「新建凭证」 | `POST /finance/vouchers` | `voucher_date, currency, summary, remark, lines[]` | `voucher-line-editor.tsx:150` |
| 分录模板 | `GET /finance/vouchers/:id/templates` | —— | `voucher-line-editor.tsx:118` |
| 「过账」 | `POST /finance/vouchers/:id/post` | 无 body | `voucher-workspace.tsx:312-318` |
| 「重新生成」 | `POST /finance/vouchers/:id/regenerate` | 无 body | `voucher-workspace.tsx:335-345` |
| 「红冲」 | `POST /finance/vouchers/:id/reverse` | `reason`（必填） | `voucher-workspace.tsx:347-353` |
| 「删除」草稿 | `DELETE /finance/vouchers/:id` | 无 body | `voucher-workspace.tsx:355-361` |
| 「导出 Excel」 | `GET /finance/vouchers/export.xlsx` | —— | `voucher-workspace.tsx:281-291` |
| 「纠正备用金/取现凭证」 | `GET` 预览 / `POST` 执行 `/finance/vouchers/cash-transfer-repair` | 无 body | `voucher-workspace.tsx:369-393` |

### 1.5 其它板块（本报告范围外，仅登记接口）

| 板块 | 主要接口 | file:line |
| --- | --- | --- |
| 应收管理 | `GET /finance/receivable-sources`、`GET /finance/reconciliations`、`GET /finance/banks`；确认/批量确认/对账确认与应付侧镜像 | `apps/web/components/finance/receivable-workspace.tsx:246-250` |
| 收付款单存档 | `GET /finance/slips`、`DELETE /finance/slips/:id`、导出同上 | `apps/web/components/finance/finance-slips-workspace.tsx:64-68`、`:98-110` |
| 银行账户 | `GET /finance/banks`、`GET /finance/banks/balances`、`POST/PATCH /finance/banks/:id` | `apps/web/components/finance/bank-workspace.tsx:78-80`、`:118-139` |
| 银行余额互转 | `GET/POST /finance/bank-transfers`、`GET /finance/banks` | `apps/web/components/finance/bank-transfer-workspace.tsx:98-100`、`:149` |
| 财务报表 | `GET /finance/reports/:tab`（+ `.xlsx`）、`GET/POST /finance/overhead-allocations` | `apps/web/components/finance/finance-report-workspace.tsx:215`；`apps/web/components/finance/overhead-allocation-panel.tsx:67-89` |
| 工资管理 | `/hr/payroll-ledgers` 全家族 + `GET /finance/banks` + `GET /finance/accounting-subjects` | `apps/web/components/finance/salary-workspace.tsx:265-296`、`:477` |

## 2 「会计科目」在界面上的全部落点

**结论先说**：这个中文词在财务前端有至少 **22 处界面落点**（下表逐条列出；非注释源码共 55 行含提示语/错误文案），但它绑定了 **6 个不同字段**：`supplier_payable_entries.subject_id`、`supplier_payable_reconciliations.subject_id`、`supplier_payments.subject_id`、`cash_flow_entries.subject_id`、`cash_flow_entries.category_subject_id`、`voucher_lines.subject_label/subject_key`（文本快照，无外键）；另有 `accounting_subjects.id`（字典本身）。界面上没有任何一处区分「业务科目 / 记账对方科目 / 凭证分录科目」。

| # | 界面位置 | 中文标签 | 绑定字段 | 数据源 | file:line |
| --- | --- | --- | --- | --- | --- |
| 1 | 应付管理 → 确认应付台账 列 | 会计科目 | `supplier_payable_entries.subject_id`（显示链：条目 > 覆盖它的对账单 > 按来源类型候选链） | `GET /finance/payable-entries` 的 `subject_name` | `payable-workspace.tsx:1049`；后端 `supplier-payable.service.ts:58-62`、`:134` |
| 2 | 应付管理 → 应付对账 列 | 会计科目 | `supplier_payable_reconciliations.subject_id` | 同上接口的 `subject`/`subjectId` | `payable-workspace.tsx:1076` |
| 3 | 应付条目详情 | 会计科目 | 同 #1 | 详情接口 + 科目表反查 | `payable-workspace.tsx:1165-1166` |
| 4 | 应付对账详情 | 会计科目 | 同 #2 | 详情接口 + 科目表反查 | `payable-workspace.tsx:1186` |
| 5 | 逐条「确认应付」弹窗 | 会计科目 | 提交 `subject_id` → 只用于生成挂账凭证借方，**不写回应付条目** | `GET /finance/accounting-subjects?include_inactive=true` 后仅启用项 | `payable-workspace.tsx:716-717`、`:530`；后端 `supplier-payable.service.ts:231-248`、`:282` |
| 6 | 批量确认弹窗 | 会计科目 | 同上（整批共一个；只有全批同科目才带默认） | 同 #5 | `payable-workspace.tsx:744`、`:559-562` |
| 7 | 按对账单确认弹窗 | 会计科目 | 提交 `subject_id`，同时写回对账单 `subjectId` | 同 #5 | `payable-workspace.tsx:872`；后端 `supplier-payable-reconciliation.service.ts:204-207` |
| 8 | 新建其他应付 | 会计科目（留空按来源自动归类） | 提交 `subject_id` → `supplier_payable_entries.subject_id` | 科目表（仅启用） | `payable-workspace.tsx:836`、`:839` |
| 9 | 创建应付对账 | 会计科目 | 提交 `subject_id` → `supplier_payable_reconciliations.subject_id` | 科目表（仅启用） | `payable-workspace.tsx:852`、`:854` |
| 10 | 合并付款弹窗 | 会计科目（可选） | 提交 `subject_id` → `supplier_payments.subject_id` | 科目表（仅启用），默认空 | `payable-merge-payment-dialog.tsx:272-273`、`:221` |
| 11 | 收支流水 列表列 | 分类 / 项目（**不叫**会计科目） | 显示 `cash_flow_entries.category_subject_id ?? subject_id` | `GET /finance/cash-flow-entries` | `cash-flow-workspace.tsx:379`、`:382-388`、`:242`；后端同口径 `cash-flow.service.ts:110-111` |
| 12 | 收支流水 筛选器 | 会计科目 | 查询参数 `subject_id`（后端按**业务科目**筛） | 科目表（启用） | `cash-flow-workspace.tsx:448-459`、`:188`；`cash-flow.controller.ts:73`、`:98` |
| 13 | 更正流水弹窗 | 会计科目 | 自动流水→`category_subject_id`；手工流水→`subject_id`（同一控件按行切换） | 科目表（启用；当前值停用时补「（已停用）」） | `cash-flow-workspace.tsx:255`、`:264-269`、`:279`；`cash-flow.controller.ts:52`、`:60` |
| 14 | 更正流水弹窗 信息行 | 记账对方科目 | 只读展示 `cash_flow_entries.subject_id` | 同 #13 | `cash-flow-workspace.tsx:283` |
| 15 | 凭证管理 → 收支流水表 列 | 会计科目 | 显示 `category_subject_id ?? subject_id`（只读） | `GET /finance/cash-flow-entries` | `voucher-workspace.tsx:398-403` |
| 16 | 凭证纸 表头列 | 会计科目 | `voucher_lines.subject_label`（文本快照，无外键） | `GET /finance/vouchers/:id` | `voucher-workspace.tsx:564`、`:568` |
| 17 | 凭证分录编辑器 每行 | 会计科目 | 下拉选中科目 id，保存时只送 `subject_key`=`分类/名称`、`subject_label`=`名称` 文本 | 科目表（仅启用，`include_inactive` 未传） | `voucher-line-editor.tsx:82`、`:199-207`；`voucher-lines.ts:163-180`；`voucher-workspace.tsx:155` |
| 18 | 收支管理 → 「会计科目」子栏目 | 会计科目 | `accounting_subjects` 字典行（分类/项目/余额方向/启用状态） | `GET /finance/accounting-subjects?include_inactive=true` | `accounting-subject-workspace.tsx:365`、`:263-266`；tab 标题 `finance-sections.ts:148` |
| 19 | 财务报表（收支两张表）筛选 | 会计科目 | `subject_id`（报表取数用） | 科目表（启用） | `finance-report-workspace.tsx:319-328` |
| 20 | 工资付款弹窗 | 会计科目 | `subject_id` → `payroll` 付款 | 科目表（默认预选「工资支付」） | `salary-workspace.tsx:224-241` |
| 21 | 建账期初余额 行 | 会计科目 | `opening_balances.subject_key` = `分类/名称` 文本键 | 科目表（含停用） | `opening-balance-panel.tsx:120-127`；`opening-balance.ts:71-73` |
| 22 | 收付款单编辑器 行 | **总账科目 / 明细科目**（不是「会计科目」） | 自由文本 `general_subject` / `detail_subject`，与科目表无关联 | 手填 | `finance-slip-editor.tsx:313`、`:317-318`；`finance-slip.ts:121`、`:129` |

**把两个不同概念都叫「会计科目」的地方**：应付台账列（业务科目 `supplier_payable_entries.subject_id`）与收支流水更正弹窗（自动流水改的 `category_subject_id`、手工流水改的 `subject_id`）共用同一个中文标签；凭证纸列又叫「会计科目」但存的是 `voucher_lines.subject_label` 文本快照，三者互不引用、界面不标注来源（`payable-workspace.tsx:1049`、`cash-flow-workspace.tsx:279`、`voucher-workspace.tsx:564`）。

## 3 应付确认弹窗规则

三个入口（逐条 / 批量 / 按对账单）字段与提交体：

| 项 | 逐条确认 | 批量确认 | 按对账单确认 |
| --- | --- | --- | --- |
| 入口 | `payable-workspace.tsx:708-724` | `payable-workspace.tsx:734-756` | `payable-workspace.tsx:866-889` |
| 弹窗字段 | 信息行、支付银行、会计科目 | 信息行（条数+按币种合计）、支付银行、会计科目 | 信息行（条数+合计）、支付银行、会计科目 |
| 提交 | `{bank_id, subject_id}` | `{ids, bank_id, subject_id}` | `{bank_id, subject_id}` |

- **会计科目是否必填**：否。`subjectEditField` 不设 `required`（`payable-workspace.tsx:545-549`），`ActionDialog` 只校验 `required` 字段（`apps/web/components/ui/action-dialog.tsx:33`）。
- **下拉数据源**：`GET /finance/accounting-subjects?include_inactive=true`（`payable-workspace.tsx:388`）→ 前端再 `filter(isActive)`（`:530`）→ 标签为「分类 / 名称」（`apps/web/lib/accounting-subjects.ts:57`）。**不按科目分类过滤、不按来源类型过滤**，就是全部启用科目。
- **默认选中什么**：逐条 = `item.subjectId`（`:716`）；批量 = `commonDraftSubjectId(drafts)`，**整批只有一个科目时才带出，否则留空**（`:559-562`、`:744`）；按对账单 = `item.subjectId`（`:872`，对账单上的科目）。合并付款弹窗默认空并显示「（不指定：按金额最大的应付来源自动归类）」（`payable-merge-payment-dialog.tsx:273`）。
- **能不能不选**：能。留空送 `undefined`（`subjectValue`，`:551`）→ 后端按「条目自己的科目 > 弹窗临时科目 > 按来源类型候选链」处理（`supplier-payable.service.ts:282`、`voucher.service.ts:272-274`）；选「（不指定会计科目）」送 `null`（`payable-workspace.tsx:547`、`:551`），对确认接口而言与留空等价。
- **银行账户 / 结算账户**：只有「支付银行（可选）」，来自 `GET /finance/banks` 的启用账户，默认「（不指定银行）」（`payable-workspace.tsx:513-521`）；**没有结算账户字段**。不选也能确认（后端不要求）。
- **银行字段实际不起作用**：确认接口只挂账，不写收支流水、不动银行账户（`supplier-payable.service.ts:251-256`、`:235-248`；`voucher.service.ts:245-256` 的 `createAccrual` 根本没有 `bank_id` 入参）；但弹窗仍让用户选「支付银行」，且成功/警告文案写着「已记入收支流水」「不会体现在任何银行账户余额里」（`payable-workspace.tsx:711`、`:717-722`、`:740`、`:752-753`、`:871`、`:885-886`）。后端该路径固定返回 `bank_missing: false`（`supplier-payable.service.ts:248`、`supplier-payable-reconciliation.service.ts:256`），所以那条警告永远不会出现。
- **已停用科目**：下拉只给启用项（`:530`），若条目 `subjectId` 指向已停用科目，`SearchableSelect` 因值不在选项里而**直接显示原始 UUID**（`apps/web/components/ui/searchable-select.tsx:347`），提交时仍送这个 UUID → 后端 422「会计科目不存在或已停用」（`supplier-payable.service.ts:234`）；用户无法保存，也无法在下拉里找回该科目。对比：收支流水页对当前停用科目补了「（已停用）」选项（`cash-flow-workspace.tsx:264-269`）。

## 4 收支流水页规则

### 4.1 新增/更正表单字段（`cash-flow-workspace.tsx:248-299`）

| 字段 | 标签 | 必填 | 默认值 | 数据源 / 说明 |
| --- | --- | --- | --- | --- |
| `entry_date` | 日期 | 是 | 今天（UTC 日期） | `:271`、`:86` |
| `counterparty_name` | 对方名称 | 是 | 现有值 | `:272` |
| `direction` | 收支方向 | 是 | 更正取现值；新增默认「支出」 | `:273` |
| `amount` | 金额 | 是 | 现有值 | `:274` |
| `currency` | 币种 | 是 | 现有值或币种表首项 | `:275` |
| `category_subject_id` 或 `subject_id` | 会计科目 | 是 | `categorySubject ?? subject` 的 id | 自动流水改类目、手工流水改主科目；仅启用（+当前停用兜底） |
| `settlement_method` | 结算方式 | 否 | 现有值 | 自由文本，`:285` |
| `settlement_account_id` | 结算账户 | 否 | 现有值 | 字典 `settlement_account`，`:289` |
| `bank_id` | 银行账户 | 否 | 现有值或「（不指定银行）」 | 银行账户池，`:290`、`:244-246` |
| `payment_nature` | 款项性质（收入用） | 否 | 现有值或「（不标注）」 | 字典，`:296` |
| `order_no` | 订单号（收入用） | 否 | 现有值 | 自由文本，`:297` |
| `remark` | 备注 | 否 | 现有值 | `:298` |

新增只提交 `subject_id`（创建 DTO 里 `subject_id` 是 `@IsUUID()` 必填，`cash-flow.controller.ts:20-44`）；`category_subject_id` 只在自动写入的流水上有值，只出现在更正路径（`cash-flow.controller.ts:46-68`）。

### 4.2 列表与科目列

- 「分类」列 = `businessSubject` 的 `category`、「项目」列 = `businessSubject` 的名字；`businessSubject = categorySubject ?? subject`（`cash-flow-workspace.tsx:379`、`:382-388`、`:242`）。
- 当两个科目都存在且不同时，主科目（记账对方科目）只挂在「项目」格的 `title` 悬停提示里（`:386-387`）。
- 列表**没有凭证列**，也没有任何「是否已生成凭证」的信息（列定义 `:370-411`）。

### 4.3 改科目 PATCH 的是哪个字段

- `editsCategory = Boolean(entry?.categorySubject)`（`:255`）：自动写入的流水（有类目）→ 提交 **`category_subject_id`**；手工流水 → 提交 **`subject_id`**。
- 同一次提交中，另一个未出现在表单里的字段不会被改动：后端 `update` 用 `input.subject_id ?? current.subjectId` 合并（`cash-flow.service.ts:152`），`category_subject_id` 只在显式提交时修改（`:154-175`）。
- 只有自动流水会显示信息行「记账对方科目：…（由来源单据决定，生成凭证用它，不在这里改）」（`cash-flow-workspace.tsx:282-284`）。

### 4.4 与来源应付/凭证的一致性提示

- **没有任何提示**说「改这里不会更新已生成的凭证」，也没有提示「与来源应付单据不一致」。更正成功的 toast 是「已更正收支流水」（`:344`），冲销是「报表不再计入这一条」（`:361`）。
- 后端流水更新明确按「流水没有下游事实」处理，不联动凭证（`cash-flow.service.ts:142-191`，注释在 `:142`）；生成凭证用的仍是 `cash_flow_entries.subject_id`（`voucher.service.ts:568-589`），不是界面显示的 `category_subject_id`。
- 来源列只显示一个来源类型徽标（`SOURCE_LABELS`，`:93-103`、`:399`）；记录里有 `sourceId`（`:64-65`）但界面不显示来源单号、不可跳转、不可回溯到对应应付/付款单。

## 5 凭证工作台规则

页面标题是「凭证管理」（`voucher-workspace.tsx:455`），无子栏目（`finance-sections.ts:157`），由两个面板组成：上「收支流水」、下「记账凭证」。

### 5.1 分录编辑能力

- 只有**草稿**凭证给出「编辑分录」（`voucher-workspace.tsx:439-440`）；已过账只有「红冲」（`:448`）；行内「重新生成」对草稿且来源为 `cash_flow_entry`/`supplier_payable` 才出现（`:333-334`、`:442-444`）。
- 编辑器可改：方向（借/贷 下拉，`voucher-line-editor.tsx:195-198`）、科目（带搜索的下拉，`:199-207`）、行摘要（`:208`）、金额（`:209`）、增行（`:213`）、删行（`:210`，至少保留 1 行）、凭证摘要与备注（`:178`、`:219`）；**不可改**凭证号、日期、期间、币种（编辑态这些来自凭证本身，`:172-176`）；**没有银行账户选择控件**。
- 保存门槛：金额非法 / 科目为空 / 缺借或贷 / 借贷不平都会拦（`:141-144`）；保存按钮在借贷不平或金额非法时禁用（`:225`），但科目为空时按钮可用、点了才报错（`:142`）。
- 保存体只有文本：`{summary, remark, lines[]{direction, subject_key, subject_label, summary, amount, bank_id}}`（`voucher-lines.ts:163-180`、`voucher-line-editor.tsx:153`）。后端把 `subject_label` 原样落库、按 `subject_key`/`label` 文本校验非空（`voucher.service.ts:1008-1035`、`:996-1005`），**凭证分录没有 `subject_id` 外键**。

### 5.2 自动生成的凭证有没有「来源单据 X 自动生成」提示与护栏

- 有来源**单号**：列表「来源」列显示「收支流水 CF-…」或「红冲 记-…」（`voucher-workspace.tsx:433-435`）；凭证纸「来源」同理（`:561`）。
- 没有「自动生成」标识或文案（全 `components/finance` 里 grep「自动生成」只出现在供应商编码与注释中）；编辑器拿不到来源信息——`EditableVoucher` 类型只有 id/凭证号/币种/摘要/备注/分录（`voucher-line-editor.tsx:41-49`），弹窗标题只有「编辑凭证 X 的分录」（`:169`）。
- 没有任何护栏：不要求填原因、不提示改完会与来源不一致、不回写来源；后端 `update` 也不校验来源，审计只记 `{voucher_no, line_edited}`（`voucher.service.ts:602-634`，审计在 `:633`）。唯一回退路径是「重新生成」（`:335-345`）。
- 手工凭证（`source_type=manual`）没有「重新生成」按钮（`voucher.service.ts:446` 会拒绝、前端 `canRegenerate` 也不含 manual），界面不解释为什么没有（`voucher-workspace.tsx:442-444` 只负责隐藏）。

### 5.3 「重新生成」「红冲」的文案与实际调用

| 按钮 | 文案 | 弹窗说明 | 实际接口 | file:line |
| --- | --- | --- | --- | --- |
| 重新生成 | 「重新生成」 | 流水来源：「按收支流水 CF-… 现在的会计科目、银行账户与金额重算整张凭证（手工改过的分录会被覆盖）」；挂账来源：「按来源应付单重建挂账凭证：借 业务科目 / 贷 应付账款（手工改过的分录会被覆盖）」 | `POST /finance/vouchers/:id/regenerate` | `voucher-workspace.tsx:335-345`、`:418`、`:443`；后端 `voucher.service.ts:436-473`、`:485-523` |
| 红冲 | 「红冲」 | 弹窗标题「红冲凭证：X」，必填「红冲原因」 | `POST /finance/vouchers/:id/reverse` | `voucher-workspace.tsx:347-353`、`:448`；后端 `voucher.service.ts:674-696` |

「重新生成」弹窗只对 `cash_flow_entry` / `supplier_payable` 两种来源给按钮；红冲凭证（`source_type=voucher`）与手工凭证没有按钮，也没有说明（`voucher-workspace.tsx:333-334`）。

### 5.4 有没有展示来源流水的收支类目

没有。流水表只显示业务科目（`:398-403`）；凭证详情里的 `source_entry` 只带 `{id, entryNo, status}`（`:57`），凭证纸只渲染 `voucher_lines.subjectLabel`（`:564`、`:568`）。所以同一笔已挂账付款：流水显示「管理费用」、凭证纸显示「借 应付账款 / 贷 银行存款」，凭证页没有任何字段解释这两者是同一笔业务的两端。

### 5.5 凭证页的其它交互

- 「新建凭证」「导出 Excel」「纠正备用金/取现凭证」在页头（`:458-465`）；纠正弹窗先 GET 预览、再 POST 执行，禁止直接执行（`:369-393`、`:521-548`）。
- 凭证纸支持打印/另存 PDF 与导出 PNG（`:510-520`、`:553-579`）。
- 后端还有「资金分录科目名刷新」`GET/POST /finance/vouchers/fund-label-refresh`（`apps/api/src/modules/finance/voucher.controller.ts:131-139`），**前端没有任何调用入口**（web 全仓 grep 无 `fund-label-refresh`）。

## 6 前端重复计算/口径风险

| # | 现象 | 影响 | file:line |
| --- | --- | --- | --- |
| 6.1 | 凭证编辑器自己算借方/贷方合计与差额，且 `difference` 又把同样的求和重算了一遍；后端过账时再算一次 | 三处实现，前端口径漂移会让「界面说平了、后端 422」或反之；合计只是显示，不会作为请求体发出 | `apps/web/lib/voucher-lines.ts:140-160`；`voucher-line-editor.tsx:125-131`、`:214-216`；后端 `voucher.service.ts:608-612`、`:641-642` |
| 6.2 | 期初余额页自己算借贷合计/差额并做保存门禁 | 与后端期初校验重复；改一处口径会与报表对不上 | `apps/web/lib/opening-balance.ts:101-120`、`:155`；`opening-balance-panel.tsx:93` |
| 6.3 | 收付款单自己算借贷合计、差额、阻断原因 | 与后端 `validateFinanceSlip` 重复（文件头已声明后端还会校验）；单子不是凭证，但同页又展示「借贷合计」，容易被读成记账口径 | `apps/web/lib/finance-slip.ts:299-320`、`:363-403`；`finance-slip-editor.tsx:25-27`、`:326-328` |
| 6.4 | 应付/应收的多币种合计用 `Number()` 浮点相加后 `toFixed` 显示，且**不按币种分组** | 「待确认应付草稿合计 / 待创建对账合计」把 USD 与 CNY 加成一个数，与批量确认弹窗里的分币种合计（后端 `supplier-payable.service.ts:330-342`）对不上；浮点还会出现尾差 | `payable-workspace.tsx:736-737`、`:941`、`:949`、`:1313`、`:1351`；`receivable-workspace.tsx:451`、`:558`、`:569` |
| 6.5 | 合并付款的「本次付款金额」由前端把各行相加得出并**作为请求金额发送**（整数分，正确），后端再按核销行汇总校验 | 两处求和；改用浮点或漏行时会出现「合计与核销不一致」的 422 | `payable-merge-payment-dialog.tsx:89-93`、`:205-212`；后端核销校验 `apps/api/src/modules/finance/supplier-payment.service.ts:82-137` |
| 6.6 | 凭证编辑器把分录科目还原成下拉值时**只按名字匹配**（`subject.name === line.subjectLabel`） | 同名不同类目的两个科目会取到第一个；保存时 `subject_key` 写成第一个的「分类/名称」，等于静默换类目（会计科目表的唯一键是 `(分类, 名称)`，允许同名，见 `accounting-subjects.ts:51-57` 注释） | `apps/web/lib/voucher-lines.ts:88`、`:168-174` |
| 6.7 | 凭证分录、期初余额都存「分类/名称」文本快照，不存 `subject_id`；科目改名后旧快照不更新 | 凭证纸/期初报表显示旧名；按名字回溯会对不上新科目（只有资金行有 `fund-label-refresh`，且无前端入口） | `voucher.service.ts:996-1005`；`opening-balance.ts:71-73`；`voucher.controller.ts:131-139` |
| 6.8 | 默认日期用 `new Date().toISOString().slice(0,10)`（UTC），而合并付款用 `formatBeijingDate`（北京时间） | 北京时间 00:00–08:00 录入时默认日期会变成**前一天**；同一系统两种日期口径 | `cash-flow-workspace.tsx:86-87`；`voucher-line-editor.tsx:74`、`:97`；`payable-workspace.tsx:584`、`:837`；`opening-balance-panel.tsx:69`；对比 `payable-merge-payment-dialog.tsx:31`、`:152`、`apps/web/lib/audit-time.ts:71` |
| 6.9 | 借贷方向：未发现前端自算方向（流水方向来自用户选择、分录方向来自用户选择），凭证纸按 `line.direction` 决定列（`voucher-workspace.tsx:569-570`）仅是展示；银行余额全部取后端 `/finance/banks/balances`（`bank-workspace.tsx:176-181`、`:192`），前端不自算 | 这一项是**没有**重复实现，列在此处用于排除 | `voucher-workspace.tsx:569-570`；`bank-workspace.tsx:169-181`、`:192` |

## 7 交互性流程缺陷

### UI-D-01 「会计科目」一名多义，界面从不区分业务科目 / 记账对方科目 / 凭证分录科目

- 现象：同一个中文标签出现在应付台账、确认弹窗、流水更正弹窗、凭证纸至少 4 类位置，分别绑定 `supplier_payable_entries.subject_id`、`cash_flow_entries.category_subject_id`、`cash_flow_entries.subject_id`、`voucher_lines.subject_label`（见 §2）。只有流水更正弹窗在**自动流水**行显示一行「记账对方科目：…（生成凭证用它）」（`cash-flow-workspace.tsx:282-284`），其它位置不解释。
- 影响：财务把「条目的业务科目」当成「凭证里的科目」；发现凭证科目不对时去改凭证或改流水，越改越乱（背景审计文档 §1 记录当天 `line_edited` 12 次、§4 列为放大因素）。
- 建议：统一术语——条目/对账/类目叫「业务科目」，流水的 `subject_id` 只在凭证语境里叫「记账对方科目」，凭证分录列头改「分录科目（快照）」；每个使用处标注来源。
- file:line：`payable-workspace.tsx:1049`、`:716`、`:836`；`cash-flow-workspace.tsx:242`、`:279`、`:379-388`；`voucher-workspace.tsx:398-403`、`:564`；`voucher-lines.ts:163-180`。

### UI-D-02 确认应付弹窗的「支付银行」是无效字段，文案却承诺会写流水、影响银行余额

- 现象：确认弹窗让用户选「支付银行（可选）」，成功/警告文案写「已记入收支流水」「不会体现在任何银行账户余额里」（`payable-workspace.tsx:711`、`:717-722`、`:740`、`:752-753`、`:871`、`:885-886`）。实际确认只把状态改为 `confirmed` 并生成挂账凭证（`supplier-payable.service.ts:235-248`、`:251-256`；`voucher.service.ts:245-256` 的 `createAccrual` 没有 `bank_id` 入参），`bank_missing` 恒为 `false`（`supplier-payable.service.ts:248`）。
- 影响：用户以为钱已经出账、账户已扣；实际资金动作要等「合并付款」才发生。`bank_missing` 警告永远不会出现，等于死代码。
- 建议：从确认弹窗移除「支付银行」（或改成「仅记录在应付单，不扣账」的只读说明），把「已记入收支流水」全部改为「确认=挂账，钱未动」；`bank_missing` 文案要么删、要么后端真正返回。
- file:line：`payable-workspace.tsx:711`、`:717-722`、`:740`、`:752-753`、`:871`、`:885-886`；后端 `supplier-payable.service.ts:231-248`、`:251-256`；`voucher.service.ts:245-258`。

### UI-D-03 确认弹窗默认科目与台账「会计科目」列不同源，留空即按候选链重算

- 现象：台账列显示「条目科目 > 覆盖对账单科目 > 按来源类型候选首位」（后端 `supplier-payable.service.ts:58-62`、`:134`）；逐条/批量确认弹窗的默认值只取 `item.subjectId`（`payable-workspace.tsx:716`、`:744`），不含覆盖对账单的科目；留空则后端按 `row.subjectId ?? options.subject_id` 再退回候选链（`supplier-payable.service.ts:282`、`voucher.service.ts:272-274`）。
- 影响：**列表上写「销售费 推广费 / 备用金」，确认后凭证却是「管理费用」**——正是用户报障的同形问题；已纳入对账单的草稿从台账行确认时，对账单上填的科目被忽略。
- 建议：弹窗默认值改用与台账列同一条链（含对账单科目），并在弹窗里显示「本次将按 X 入账（来源：条目/对账单/系统候选）」。
- file:line：`payable-workspace.tsx:716`、`:744`、`:1049`；`supplier-payable.service.ts:58-62`、`:134`、`:282`；`supplier-payable-reconciliation.service.ts:230`。

### UI-D-04 确认弹窗里临时改的科目不落回应付条目，一次修正不沉淀

- 现象：确认接口的 `subject_id` 只用于本次 `createAccrual`（`supplier-payable.service.ts:282`），事务里只更新 `status`（`:241`）；前端也不在成功后 PATCH 条目。台账「会计科目」列下次仍显示旧值/候选值。
- 影响：财务每次确认都得重选一次，漏选就回到错误科目；「这条应付到底挂哪个科目」在台账上没有唯一事实。
- 建议：确认时把弹窗选中的科目写回 `supplier_payable_entries.subject_id`（或生成不可变快照并在台账显示「确认时科目」），界面注明这次选择会持久化。
- file:line：`payable-workspace.tsx:716-717`；`supplier-payable.service.ts:235-248`、`:282`。

### UI-D-05 已停用科目在确认弹窗里「消失」并显示原始 UUID，确认会被 422 卡死

- 现象：科目下拉只含启用项（`payable-workspace.tsx:530`），而默认值仍是 `item.subjectId`（`:545-548`）。当该科目已停用时：`SearchableSelect` 找不到选项就**显示 value 本身**（`apps/web/components/ui/searchable-select.tsx:347`），用户看到一串 UUID；不换科目直接提交，后端按「科目已停用」拒绝（`supplier-payable.service.ts:234`），而该科目又不在下拉里，无法选回。
- 影响：历史/停用科目的应付无法确认，且错误提示指向一个界面上不存在的科目。
- 建议：照抄流水页的做法，为当前值补一条「（已停用）」选项并允许原样提交（`cash-flow-workspace.tsx:264-269`）。
- file:line：`payable-workspace.tsx:530`、`:545-548`；`searchable-select.tsx:347`；`cash-flow-workspace.tsx:264-269`。

### UI-D-06 收支流水页改会计科目不联动已生成凭证，页面也不显示「是否已有凭证」

- 现象：流水列表没有凭证列（`cash-flow-workspace.tsx:370-411`），「更正」对所有生效流水开放（`:407`）；PATCH 只改流水（后端注释明确「流水没有下游事实，允许直接改」，`cash-flow.service.ts:142-191`）。已生成的凭证只有在凭证页对**草稿**点「重新生成」才会同步（`voucher-workspace.tsx:442-444`），已过账只能红冲。
- 影响：用户以为改完流水账就对了；实际凭证（报表取数来源）仍是旧科目，且用户不知道要回凭证页重算。
- 建议：流水行显示凭证号+状态；当该流水已有凭证时，在更正弹窗顶部提示「此流水已生成凭证 X（草稿/已过账），改科目不会自动更新，需要到凭证页重新生成/红冲」，并提供跳转。
- file:line：`cash-flow-workspace.tsx:334-350`、`:370-411`、`:407`；`voucher-workspace.tsx:442-444`；`cash-flow.service.ts:142-191`。

### UI-D-07 流水页同一个「会计科目」控件对不同行改不同字段，且只有部分行有说明

- 现象：`editsCategory = Boolean(entry?.categorySubject)`（`cash-flow-workspace.tsx:255`）决定提交 `category_subject_id` 还是 `subject_id`；信息行只在 `editsCategory` 为真时出现（`:282-284`）。手工流水/历史自动流水（类目为空）改的其实是「记账对方科目」——生成凭证用的那个字段。
- 影响：同样一个弹窗、同一个标签，用户改的可能是「这笔钱算什么」，也可能是「凭证另一头记到哪」，结果完全不同且无提示。
- 建议：拆成两个字段：「业务科目（收支类目）」与「记账对方科目」；后者只读或明确标注「由来源单据/系统决定，仅高级修正时开放」。
- file:line：`cash-flow-workspace.tsx:242`、`:255`、`:279`、`:282-284`；`cash-flow.controller.ts:52`、`:60`。

### UI-D-08 凭证分录编辑器对自动生成的凭证没有任何「自动生成」标识与护栏

- 现象：只要凭证是草稿就出现「编辑分录」（`voucher-workspace.tsx:439-440`），可改方向/科目/金额/增删行（`voucher-line-editor.tsx:192-213`），不显示来源、不要求原因、不回写来源；保存前后端审计只记 `line_edited: true`（`voucher.service.ts:602-634`、审计 `:633`）。
- 影响：手改后凭证与来源流水/应付单不一致，且改前科目无痕迹（2026-11-04 线上就发生过 12 次手改）；「重新生成」能救回草稿，但已过账的只能红冲。
- 建议：编辑器顶部显示「由收支流水 CF-…/应付单 APO-… 自动生成」；改科目时要求填原因并把改前/改后科目写审计；对系统生成的业务科目行提供「锁定/只读」开关（是否禁止改业务科目需产品拍板）。
- file:line：`voucher-workspace.tsx:439-446`、`:335-345`；`voucher-line-editor.tsx:138-165`、`:192-213`；后端 `voucher.service.ts:602-634`、`:996-1005`。

### UI-D-09 分录编辑器不能选银行账户：换资金行科目后 bank_id 仍是原账户

- 现象：编辑器行只有 方向/科目/摘要/金额/删除（`voucher-line-editor.tsx:192-211`），没有银行账户控件；`bankId` 只能从凭证原分录或模板带出（`:103`、`voucher-lines.ts:203`），保存时原样送回（`voucher-lines.ts:177`）。用户把「银行存款-农行」改成「银行存款-中行」科目，`bank_id` 仍指农行账户。
- 影响：凭证上看是「中行」，银行余额/明细账却记在农行账户；新建凭证也无法给资金行指定账户。
- 建议：资金行增加「银行账户」下拉（数据源 `GET /finance/banks`），或在科目为资金类时联动要求选账户；后端 `voucher.service.ts:619-626` 已支持逐行 `bank_id`。
- file:line：`voucher-line-editor.tsx:192-211`、`:103`；`voucher-lines.ts:163-180`；`voucher.service.ts:607`、`:619-626`。

### UI-D-10 红冲与来源流水不联动：红冲后流水仍显示「已生成凭证（无状态）」，该流水也无法再生成新凭证

- 现象：前端 `voucherByEntry` 收集该来源的全部凭证、不过滤状态（`voucher-workspace.tsx:187-191`），流水行「凭证」列只显示凭证号（`:408`）；红冲后原凭证为 `reversed`，流水仍显示它，「重新生成」按钮不出现（`:442-444`）。此时再点「生成凭证」会命中原凭证按幂等返回 `replayed`，前端提示「已有凭证…重复生成不会重复建单」并打开那张已红冲的凭证（`:209-223`；后端 `voucher.service.ts:176-177`）；已红冲凭证也不能删除（只允许草稿，`voucher.service.ts:653-657`）。
- 影响：一笔支出红冲后无法恢复成正确凭证，流水页也看不出问题。
- 建议：流水行显示凭证状态（草稿/已过账/已红冲）；红冲弹窗提示「来源流水仍生效，之后不会再生成新凭证」；提供「作废已红冲凭证并重新生成」路径（或红冲时同步处理来源流水）。
- file:line：`voucher-workspace.tsx:187-191`、`:209-223`、`:408`、`:412-420`；`voucher.service.ts:172-177`、`:653-657`。

### UI-D-11 凭证纸/凭证详情不展示来源流水的收支类目，两个科目在凭证页无法对读

- 现象：`source_entry` 只有 id/流水号/状态（`voucher-workspace.tsx:57`），凭证纸只渲染分录科目（`:564-571`）；流水表显示的是业务科目（`:398-403`），但凭证纸显示的是分录科目（已挂账付款 = 应付账款）。同一笔业务在「流水」与「凭证」两处两个科目，凭证页没有任何说明。
- 影响：用户会再次判断「会计科目又错了」（背景审计文档 §1 的报障原形）。
- 建议：凭证详情/凭证纸增加只读「来源业务科目（收支类目）」行，并注明「分录科目=记账口径；业务科目=来源单据口径」。
- file:line：`voucher-workspace.tsx:57`、`:398-403`、`:553-578`；后端 `voucher.service.ts:568-589`（凭证业务行取 `subject_id` 而非类目）。

### UI-D-12 台账/汇总用浮点且跨币种相加，显示合计与后端按币种分组口径不一致

- 现象：批量确认弹窗与流转看板用 `Number()` 求和后 `toFixed`，且不按币种分组（`payable-workspace.tsx:736-737`、`:941`、`:949`、`:1313`、`:1351`）；后端批量确认明确按币种分组返回（`supplier-payable.service.ts:330-342`）。
- 影响：多币种时「待确认应付草稿 N 条（合计 X）」是一个无意义的数字，和弹窗里的「合计 USD…、CNY…」对不上；财务会怀疑少算/多算。
- 建议：所有合计按币种分组显示；金额统一走整数分工具（`parseSlipAmount`/`formatSlipAmount` 或等价实现）。
- file:line：`payable-workspace.tsx:736-737`、`:941`、`:949`、`:1313`、`:1351`；`receivable-workspace.tsx:451`、`:558`、`:569`；后端 `supplier-payable.service.ts:330-342`。

### UI-D-13 收付款单的「总账科目/明细科目」是自由文本，与流水/凭证又是两套口径

- 现象：付款单编辑器把科目做成手填 Input（`finance-slip-editor.tsx:313`、`:317-318`），标签为「总账科目 / 明细科目」（`finance-slip.ts:121`、`:129`），与 `accounting_subjects` 无任何关联；同一笔付款在「付款单打印件」「收支流水」「记账凭证」三处各有一套科目，界面互不引用、互不校验。
- 影响：打印件与账上科目对不上时，财务无法判断哪个是错的；三处同名概念进一步加剧「会计科目到底是什么」的困惑。
- 建议：单据科目改为科目表下拉（与全站同源），或明确标注「仅打印用、不入账」并在列表/凭证页交叉引用同一笔业务的另外两处科目。
- file:line：`finance-slip-editor.tsx:312-331`；`finance-slip.ts:115-137`；`voucher-workspace.tsx:564`。

### UI-D-14 科目改名/停用与凭证文本快照漂移；编辑器按名字匹配还会取错类目

- 现象：科目页可直接改名（`accounting-subject-workspace.tsx:153-172`），而凭证分录只存「分类/名称」文本快照（`voucher.service.ts:996-1005`）、期初余额也用文本键（`opening-balance.ts:71-73`），不会随改名更新；编辑器还原分录科目时按 `subject.name === subjectLabel` 匹配（`voucher-lines.ts:88`），同名不同类目会静默取第一个并把 `subject_key` 改成该类的「分类/名称」（`:168-174`）。后端虽有 `fund-label-refresh`（只刷草稿资金行），前端没有入口（`voucher.controller.ts:131-139`）。
- 影响：改一次科目名，历史凭证/期初报表显示旧名；同名科目会被换类目，报表行跟着错位。
- 建议：分录/期初改存 `subject_id` + 快照；按 id 还原、按名字只做兜底并提示；在凭证页提供「刷新资金科目名」入口，改名时提示影响范围。
- file:line：`accounting-subject-workspace.tsx:153-172`；`voucher-lines.ts:88`、`:163-180`；`opening-balance.ts:71-73`；`voucher.controller.ts:131-139`。

### UI-D-15 流水页不显示来源单号、不可跳转，改错科目无法回溯来源应付

- 现象：流水记录有 `sourceType/sourceId`（`cash-flow-workspace.tsx:64-65`），列表只渲染一个来源类型徽标（`:399`），没有来源单号、没有链接；`sourceId` 未在界面使用。
- 影响：财务在流水页看到「供应商付款 / 确认应付」却不知道对应哪张应付、哪张付款单；科目被改错时找不到源头核对。
- 建议：来源列显示来源单号（应付单号/付款单号/收款单号）并提供跳转；确认应付写入流水时把来源单号一并展示。
- file:line：`cash-flow-workspace.tsx:64-65`、`:93-103`、`:399`。

## 8 结论

1. 前端把「会计科目」这个词复用在 6 个不同字段上（应付/对账/付款单的 `subject_id`、流水的 `subject_id` 与 `category_subject_id`、凭证分录的文本快照），且没有任何一处标注来源，这是用户「会计科目记录不令人满意」的界面级根因。
2. 应付确认弹窗仍停留在「确认即记账」时代的交互（支付银行、已记入收支流水、bank_missing 警告），而当前接口只挂账不写流水，字段与文案都在误导用户。
3. 确认弹窗的默认科目与台账显示不同源、临时改的科目不落库、停用科目显示 UUID 并卡死提交，使「确认这一次」与「台账上的科目」永远无法一致。
4. 收支流水页可以随时改科目但不显示凭证、不提示不联动；凭证编辑器对自动生成的凭证无标识、无原因、无 before/after 审计，且不能选银行账户，两处叠加就是「越改越乱」。
5. 建议优先做三件事：统一「业务科目 / 记账对方科目 / 分录科目」的命名与展示（§2、UI-D-01/11）、修确认弹窗的字段与默认值链（UI-D-02/03/04/05）、给凭证编辑器加来源提示与只读护栏（UI-D-08/09/10）；前端自算合计与浮点跨币种问题（§6、UI-D-12）可作为同批修复。
