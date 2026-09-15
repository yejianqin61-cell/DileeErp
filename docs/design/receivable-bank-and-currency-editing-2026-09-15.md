# 应收侧的银行选择 + 应收/应付全路径币种（2026-09-15）

用户三条：

1. 「所有应收管理，都要选择银行，从银行池里选择」
2. 「排查所有的应收管理，应付管理，都要支持选择币种，编辑币种」
3. 「所有工资相关的，也要展示币种，都是人民币。」

## 一、先排查：银行与币种分别缺在哪

| 单据 | 币种（选 / 改） | 银行（银行池 `bank_id`） |
| --- | --- | --- |
| 应收来源（成品出库条目，`receivable_sources`） | 由销售订单带出；草稿可改 ❌→✅ | 不涉及（还没收款） |
| 收款单（`customer_payments`） | 建单有；**编辑没有** ❌→✅ | **整个字段都不存在** ❌→✅ |
| 应收对账（`receivable_reconciliations`） | 建单有（快照币种） | **不存在** ❌→✅ |
| 应付条目（`supplier_payable_entries`） | 建单有（来源带出 / 其他应付手填）；**编辑没有** ❌→✅ | 不涉及（还没付款） |
| 供应商付款（`supplier_payments`） | 建单有；**编辑没有** ❌→✅ | 建单有（上一轮做的）；**编辑没有** ❌→✅ |
| 应付对账（`supplier_payable_reconciliations`） | 建单有 | 建单有（上一轮做的） |
| 应收调整（`receivable_adjustments`） | 建单有（DTO 一直有 `currency`） | 不涉及（无资金账户） |

排查结论有两处**根因**，都不是「下拉忘了加」，而是**后端根本不接受这个字段**：

- `customer_payments` / `receivable_reconciliations` 两张表**没有 `bank_id` 列**（上一轮银行池只接到应付侧），
  所以应收页连字段都无从渲染；
- 四个草稿编辑接口的入参签名里**没有 `currency`**（`customer-payment.updateDraft`、
  `supplier-payment.updateDraft`、`receivable.updateDraft`、`supplier-payable.updateDraft`），
  前端就算发了也会被 DTO 白名单丢掉 —— 这正是「编辑币种」做不到的原因。

## 二、银行：只有一处主数据

银行账户池（财务 → 银行账户，`banks` 表 + `GET/POST/PATCH/PATCH toggle/DELETE /finance/banks`）是
**唯一的账户主数据**。收付款/对账只存外键 `bank_id`，账号与开户名不冗余快照（改主数据即全局生效，
与应付侧上一轮的做法一致）。

新增 `apps/api/src/modules/finance/bank-selection.ts`：

```ts
requireActiveBank(client, bankId, message)  // 空值 → null；未删除 + 启用 → 账户；否则 404 BANK_NOT_FOUND
```

- **为什么外键不够**：停用的账户仍在库里，`FOREIGN KEY` 拦不住；只靠前端过滤下拉也不够（接口可被直接调用）。
- **为什么不做成快照**：账户名/账号会变，快照会让「支付银行」与主数据长期不一致。
- 四类写路径都用它：收款建单、收款编辑、付款建单（上一轮漏了校验，这次补上）、付款编辑、应收对账、应付对账（既有）。

### 迁移

`20260915160000_receivable_bank_selection`：

```sql
ALTER TABLE "customer_payments" ADD COLUMN "bank_id" UUID;
ALTER TABLE "receivable_reconciliations" ADD COLUMN "bank_id" UUID;
-- FK ... ON DELETE SET NULL ON UPDATE CASCADE（可空关联，Prisma 期望的语义）
```

可空是刻意的：历史数据没有这个字段，且「钱到了但还没确定打哪张卡」的草稿要能存。
静态守卫见 `apps/api/test/unit/receivable-bank-selection-migration.test.cjs`。

### 收款过账 → 收支流水

收款过账时把 `bank` 一起取出来，`settlementMethod` 按老表格式写成 `转账--农业银行5706`，
并把 `{ bankName, accountNumber }` 作为 `settlementAccountHint` 传给 `CashFlowService`
（按账号匹配「结算账户字典」的 `settlement_account_id`）。

- 银行池与**结算账户字典**仍是两个概念：前者是主数据（`bank_id`），后者是收支流水/老表的字典项
  （`settlement_account_id`），两者没有外键关系，只在写流水时按「账号数字相等 + 银行名包含」保守匹配，
  匹配不上就留空交给人工，不猜。

## 三、币种：草稿可改，且改完仍然自洽

四个草稿编辑接口补上 `currency`，一律先过币种字典（`CurrencyService.assertSupported`）。
之所以敢让草稿改币种：**核销只可能发生在过账时**，草稿阶段没有任何已核销记录，
不存在「改了币种但核销明细还是旧币种」的中间态；而且过账仍然逐条校验
（收款 `source.currency === payment.currency`、付款 `entry.currency === payment.currency`），
改错了会在过账时被明确拦下，不会静默串账。

编辑弹窗里的「清空银行」：Radix `Select` 不接受空串 value，所以用哨兵值 `__no_bank__`
（显示为「（不指定银行）」），提交时翻译成 `null`；`null` = 清空，`undefined` = 不改。
DTO 侧用 `@IsOptional()`（跳过 `null`）保证 `bank_id: null` 能通过白名单。

币种**不支持**改的地方，以及原因：

- 对账单（应收/应付）：是**快照单据**，创建后连金额都不允许改，币种同样不可改；要修正只能另建一张。
- 接收应付（`POST /payable-entries/from-source`）：币种来自来源单据（原料入库/外加工签收按采购单币种），
  接收时改了会与来源凭证不一致；需要改就在**草稿编辑**里改（本次已支持）。
- 应收调整：后端一直支持 `currency`，但**页面尚未开放这个功能**（无 UI），属于已知缺口。

## 四、工资：统一人民币，但要看得见

工资的币种字段一直存在（`payroll_ledgers.currency`，建单/编辑/导入都写 CNY），缺的是**展示**：

- 工资台账满屏表格新增「币种」列（读取 `row.currency`，空值兜底 `CNY`），
  并给出只读说明「工资统一以人民币（CNY）核算」；
- 工具条月份旁补一句「币种 人民币（CNY）」，与可多币种的应收/应付单据区分开；
- 工资付款表在上一轮就有「币种」列，台账详情里也一直有 —— 现在三个工资界面都能看到币种。
