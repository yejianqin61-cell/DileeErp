# 银行余额管理：期初金额、账户互转，以及确认应收应付即记账（2026-09-16）

> 用户原文（五条）：
> 1. 「现在要创建好银行账户的余额管理。直接在财务那边新开一个栏目，叫做银行余额互转。在里面允许我们对我们银行池中的银行账户中的金额进行互相转账。操作表单要包含，本方账户，本方币种，对方账户，对方币种。同时允许对银行初金额的设置」
> 2. 「所以应收应付这边，一旦确认应收，或者确认应付，金额就要进入或转出对应的账户」
> 3. 「应收应付那边，所有表单都要允许填写银行账户」
> 4. 「应收应付那边，所有表单都要允许填写收支管理中的收支项目维护。」
> 5. 「因此，财务报表中的收支明细表才能正确统计所有收支流水根据收支项目分类的明细」

## 1. 排查结论：余额此前根本算不出来

| # | 事实 | 证据 | 后果 |
| --- | --- | --- | --- |
| A | **`banks` 表没有余额概念** | `Bank` 模型只有银行/账户/币种/启用位（`schema.prisma`），期初、余额都没有列 | 「银行账户的余额管理」无处落脚 |
| B | **收支流水不指向银行账户** | `cash_flow_entries.settlement_account_id` 指向的是**结算账户字典**（老表「结算方式」里的 `农业银行5706` 文本），与 `banks` 没有任何外键关系；`CashFlowService.matchSettlementAccount()` 只能按「账号数字一致 + 银行名互相包含」去**猜** | 即使有余额也只知道「有个叫农业银行5706的字典项」，不知道钱在哪张卡上；自动流水经常猜不中，`bank_id` 干脆是空的 |
| C | **确认应收 / 确认应付只改状态，不动钱** | `ReconciliationService.confirmReceivables()` 只把草稿应收置 `confirmed`；`SupplierPayableReconciliationService.confirmPayables()` 只置 `confirmed` | 用户说的「确认后金额要进入/转出账户」完全没有实现路径 |
| D | **收支项目在单据上无处可填** | 只有「过账」那一刻能临时选一个（`PostPaymentDto.cash_flow_item_id`），收款单/付款单/对账单本身没有这一列 | 财务在表单里填不了项目，`收支明细表` 里全是按来源**自动归类**的结果，「按项目分类统计」实际是「按代码写死的规则分类」 |
| E | **收支明细表看不到项目** | `CASH_FLOW_DETAIL_COLUMNS` 是照抄老表的 6 列（日期/对方名称/币种/收入/支出/结算方式） | 汇总表说「货款 5000」，明细表里只有一串 5000，**对不上号** |
| F | **没有账户间互转** | 全库没有 transfer 概念 | 从 A 账户调钱到 B 账户只能录两条手工流水（一收一支），把收支口径彻底污染 |

## 2. 决策（为什么这样做）

- **D1 余额是一个公式，不是一列数**：`余额 = 期初余额 + 生效收入流水 − 生效支出流水 + 转入 − 转出`。
  只有期初余额是存下来的（`banks.opening_balance`），其余每一项都是聚合出来的。
  存一个「当前余额」列会在每次动账时都要记得改它，一旦漏改就永久对不上；聚合永远与明细自洽。
- **D2 只算落在本账户上的流水**：`cash_flow_entries.bank_id` 指明钱在哪张卡上。
  没指定 `bank_id` 的流水仍然是**收支事实**（报表里有、汇总表里算），但它不属于任何账户，
  因此不进任何账户余额。这一点不能让它看起来像「这笔钱凭空消失了」。
  （2026-09-16 更新：原本靠界面说明段讲这件事，该说明段已按用户要求删除；现在靠**确认弹窗的警告**
  与 `bank_missing` 的错误态 toast 表达 —— 这才是「不做任何说明」之后仍然必须保留的东西。）
- **D3 互转单独一张表，绝不写收支流水**：`bank_transfers`。互转既不是收入也不是支出；
  写成「A 支出 + B 收入」会让收支汇总表凭空多出一笔收入与一笔支出。
  它只在计算银行余额时参与。**收支明细表里因此不出现互转行 —— 这是有意的口径，不是漏算。**
- **D4 收支项目在**建单时**就落库**：收款单/付款单/应收对账/应付对账各加 `cash_flow_item_id`。
  表单里填过的东西不能在「过账/确认」之前丢掉。过账/确认时仍可临时覆盖（那个参数保留），
  优先级是「过账时选的 > 建单时存的 > 按业务来源自动归类」。
- **D5 确认即记账，且「确认」与「记账」同生共死**：确认应收/应付时按确认金额写**一条**收支流水
  （应收=收入、应付=支出），来源是 `receivable_reconciliation` / `supplier_payable_reconciliation`。
  校验（银行是否在池子里且启用、项目是否存在）**在事务之前**做：等事务提交完才发现银行非法，
  应收已经被确认、流水却没写，账面上凭空少一笔钱，比直接拒绝糟得多。
- **D5b 「确认」有两条入口，两条都要记账**：界面上「确认应收」既在**对账单行**上（一键确认一批），
  也在**应收来源/应付条目行**上（逐条确认），还有「按订单批量确认」。只在其中一条上记账，
  用户点另一条时看到的仍然是「确认了但银行余额没动」。因此：
  - 逐条确认 → 每条一条流水（来源 `receivable_source` / `supplier_payable_entry`）；
  - 按订单批量确认 → **每条应收各一条**流水（批量没有单张单据可挂，逐条才追得回去）；
  - 按对账单确认 → 一条按对账单汇总的流水（对账单本身就是一张凭证）。
  三条路径共用 `recordConfirmation` 的「同来源只应有一条流水」，且一条应收/应付一旦被确认
  就不再是草稿，另一条入口的 `status = draft` 条件自然捞不到它 —— 不会重复记账。
- **D6 同一条来源只有一条收支流水，金额是**累计确认额**（累加，不覆盖、不跳过）**：对账范围是**活范围**
  （同客户/供应商 + 币种 + 期间），确认一次之后同期间新进来的草稿还能再确认一次。
  沿用 `autoCreateFromPayment` 的「已存在就跳过」会让银行账永远停在第一次确认的数字上。
  而「覆盖」在两条确认入口交叉时同样会出错：先按对账确认 100，再逐条确认新来的 50，
  回头再点一次对账确认，对账那条流水会被改写成 50，总额凭空少 100。
  因此新增 `CashFlowService.recordConfirmation()`：**不存在就建、存在就把本次金额累加上去、金额为 0 就不动**。
  更新时保留首次确认的日期（一条累计流水只有一个日期），银行账户与收支项目取最新一次。
- **D7 账户币种必须自洽**：`banks` 一行只对应一个币种，所以互转表单里的「本方币种/对方币种」
  默认取所选账户的币种，显式传了不一致的直接 422 `TRANSFER_CURRENCY_MISMATCH`。
  允许「人民币户转出美元」会让余额变成一笔算不清的混币账。这四个字段是用户点名的，所以表单照做，
  但语义是「账户的币种」而不是「随便选的币种」。
- **D8 同币种互转两边金额必须相等**：`A 账户 −100 / B 账户 +99` 不是转账，是凭空少了 1 块钱。
  这种差额只能是汇兑损益或手续费，而这两个概念本系统都还没有科目承载，所以宁可挡住也不静默接受。
  跨币种则必须由财务填实际到账数，汇率按 `toAmount / fromAmount` 记 6 位小数**快照**（不参与换算）。
- **D9 余额不足只提示、不拦截**：期初余额可能还没录、银行到账也有时间差，硬拦会挡住真实业务。
  但财务必须看到 —— `POST /finance/bank-transfers` 的响应带 `source_balance_before/after` 与
  `insufficient_balance`，界面据此给明确警告。
- **D10 冲销而不是删除**：互转用 `status = reversed` 保留整行（与收支流水、收付款一致）。
  已发生的资金动作不能凭空消失。
- **D11 期初余额允许 0、不允许负数**：负期初只可能来自透支或历史错误。透支需要额度与利息科目，
  本系统没有；历史错误应该在录入时改对。真要表示透支户，先按 0 建账、把欠款当支出录进来。

## 3. 改动清单

### 3.1 数据模型（迁移 `20260915180000_bank_balances_and_transfers`）

| 对象 | 变化 | 关键点 |
| --- | --- | --- |
| `banks` | `+ opening_balance DECIMAL(18,4) NOT NULL DEFAULT 0` | 非空默认 0：0 与「没录期初」必须可区分，NULL 会让余额算不出来 |
| `cash_flow_entries` | `+ bank_id UUID` + `@@index([bankId, status])` | 可空关联 → `ON DELETE SET NULL`。缺索引会让每次算余额全表扫流水 |
| `customer_payments` / `supplier_payments` | `+ cash_flow_item_id UUID` | 建单时存收支项目 |
| `receivable_reconciliations` / `supplier_payable_reconciliations` | `+ cash_flow_item_id UUID` | 同上 |
| `bank_transfers` | 新表 | `transfer_no` 唯一；`from/to_bank_id` 必填（RESTRICT）；`from/to_currency`、`from/to_amount`、`exchange_rate`、`status`、`reversal_reason`；`(transfer_date,status)`、`(from_bank_id,status)`、`(to_bank_id,status)` 三个索引 |

库层兜底：`from_amount > 0 AND to_amount > 0`、`from_bank_id <> to_bank_id`、`status IN ('posted','reversed')`
（与 `cash_flow_entries_*_check` 同一做法：即使有写入绕过 HTTP 服务，也不允许出现算不清的互转）。

### 3.2 API

- **`bank-balance.domain.ts`（新）**：纯函数 `bankBalance(opening, parts)`、`transferAmounts({fromAmount,toAmount,fromCurrency,toCurrency})`、
  `transferEffect(bankId, row)`、`emptyBankBalanceParts()`。余额公式只有这一处实现，服务层只负责取数。
- **`BankService`**：
  - `create/update` 接受 `opening_balance`（`opening()` 校验：允许 0、空串按 0、负数与非数字 422 `INVALID_OPENING_BALANCE`）；
  - `balances(asOf?)`：三个查询，不做 N+1 —— 一次取账户、一次 `groupBy(by: [bankId, direction])`、
    一次取全部生效互转（外加一次 `groupBy(by: [bankId])` 给「这个余额由几条流水撑起来」）。
    返回 `opening_balance / cash_in / cash_out / transfer_in / transfer_out / balance / cash_flow_count`；
  - `balanceOf(id, asOf)` 给单账户（不存在时 404，不返回一个看起来正常的 0）。
- **`BankTransferService` + `BankTransferController`（新）**：`GET/POST /finance/bank-transfers`、
  `GET /:id`、`POST /:id/reverse`。四项用户点名的表单字段全部在 DTO 里；两个账户都必须存在+未删除+未启用，
  不能自己转给自己，币种与金额按 D7/D8 校验。
- **`BankController`**：`GET /finance/banks/balances?as_of=`、`GET /finance/banks/:id/balance`。
  **`balances` 路由必须声明在 `:id` 之前**，否则会被当成一个账户 id 去查（Nest 按声明顺序匹配）。
- **`CashFlowService`**：
  - 入参/列表新增 `bank_id`/`bankId`，`ENTRY_INCLUDE` 带出 `bank`；
  - `prepare()` 用 `requireActiveBank` 校验银行（与收付款、对账同一口径）；
  - `autoCreateFromPayment()` 新增 `bankId` 入参：收付款过账时把单据的银行**直接**写进流水的 `bank_id`
    （`settlementAccountHint` 依然保留 —— 那是拿去猜老表结算账户字典的兜底，两件事不能混为一谈）；
  - 新增 `requireItem(itemId)`（建单时校验收支项目）与 `recordConfirmation()`（D6）。
- **`ReconciliationService`（应收）**：`create` 接受并校验 `cash_flow_item_id`；
  `confirmReceivables(id, user, { bank_id, cash_flow_item_id })` 在事务前校验、事务内记账用的银行/项目
  **回写到对账单上**（单子上写的与实际记账用的必须一致），事务后写收支流水并回报
  `cash_flow_entry_id` 与 `bank_missing`。
- **`ReceivableService.confirm` / `batchConfirmByOrder`（D5b）**：逐条/批量确认同样记账，
  返回 `cash_flow_entry_id(s)` 与 `bank_missing`。
- **`SupplierPayableReconciliationService`（应付）**：完全对称。项目候选链按**本次确认金额最大的来源类型**
  选定（原料入库 → 原材料 成本；外加工签收 → 成品外加工费），与供应商付款过账同一套归类口径。
- **`SupplierPayableService.confirm`（D5b）**：逐条确认应付同样记账，项目候选链按该条的 `sourceType` 选定。
- **`CustomerPaymentService` / `SupplierPaymentService`**：建单接受并落库 `cash_flow_item_id`，
  `updateDraft` 支持改/清空；过账时优先级为「过账参数 > 单据上的 > 来源候选链」；
  过账写流水时带上 `bankId`。
- **`finance-report-query.service.ts` / `finance-report.tables.ts`**：收支明细表从老表的 6 列扩到 **8 列**
  （新增「收支项目」与「银行账户」）。这是**有意偏离**老表版式（用户第 5 条要求）：
  没有项目列，汇总表按项目分类的数字在明细里根本对不上号。项目缺失时留**空单元格**而不是横杠 ——
  导出到 Excel 后空单元格可以被筛选、可以被求和，横杠会被当成文本混进数值列。

### 3.3 前端

- `components/finance/bank-workspace.tsx`：建/改账户可填**期初余额**；表格新增「期初余额」「当前余额」
  （数据来自 `/finance/banks/balances`），并展示余额构成（期初 / 收 / 付 / 转出 / 转入）。
- `components/finance/bank-transfer-workspace.tsx`（新）+ `app/finance/bank-transfers/page.tsx`（新）：
  「银行余额互转」栏目。表单字段就是用户点名的四项 + 金额 + 日期 + 备注；余额不足给明确警告。
- `lib/finance-sections.ts`：`FINANCE_BOARDS` 新增 `bank-transfers` 板块。
- `components/finance/cash-flow-workspace.tsx`：手工流水新增**银行账户**字段与列（与「结算账户」并存，
  注释里写清两者区别）。
- `components/finance/receivable-workspace.tsx` / `payable-workspace.tsx`：创建对账、登记收/付款、
  编辑草稿都可填**收支项目**；「确认应收 / 确认应付」改成弹窗，可补/改**银行账户 + 收支项目**，
  并在响应 `bank_missing` 时明确警告。**逐条确认、按订单批量确认、一键确认三条入口都要弹窗收这两个字段**
  （见 D5b）。

## 4. 已知缺口（本轮未做，且必须知道）

1. **没有历史数据回填**（用户既定口径「先不用管历史数据」）：升级前已有的收支流水 `bank_id` 全为空，
   因此**它们不进任何账户余额**。老库的 `banks` 表本来就是空的（账户只在「结算账户字典」里有两条文本），
   期初余额需要财务手工建账户 + 手填。
2. **确认应收/应付生成的流水日期是「确认当天」**：不是对账期间的期末日。会计上更严谨的做法是按
   对账期间记账，但那会让「确认」这个动作把流水写进过去，与「流水按发生日排序」的既有口径冲突，
   需要业务确认。
3. **对账单仍没有「同客户/供应商 + 期间 + 币种唯一」约束**（第十一轮遗留）：范围重叠的两张对账单会
   同时覆盖同一条草稿，确认两次就会**累加**到同一条流水上（`recordConfirmation` 保证不重复建单，
   但金额会是两次确认的合计）。要不要加约束需要业务确认。
4. **互转没有审批/复核**：建单即生效（与其他财务单据的「先草稿后过账」不同）。互转的金额一般不大、
   且冲销入口就在列表行上，所以本轮按「直接生效 + 可冲销」做。
5. **余额不足不拦截**（D9），且**没有银行对账单导入/对账**功能：余额是「系统算出来的数」，
   与真实银行流水的核对仍需财务手工做。
6. **本机没有 PostgreSQL**：迁移未在真实库上执行过；`迁移守卫测试` 只做静态断言
   （目录顺序、列可空性、FK 的 ON DELETE、CHECK 约束、schema 与迁移的一致性）。
7. **工资付款（`salary_payments`）没有银行账户字段**：它过账后照旧写收支流水（`bank_id` 为空），
   因此工资这笔支出**不进任何银行账户的余额**。用户这次点名的是「应收应付那边」，
   工资侧补 `bank_id` 需要动 `hr` 模块的表与工资付款页，留作下一步；在那之前，
   银行余额与真实银行账之间会固定差一笔工资。
8. **应收调整（`POST /finance/receivable-adjustments`）没有银行账户/收支项目字段**：
   它是纯金额调整（不产生资金动账），因此按设计不该有；页面本身也还没有入口（遗留缺口）。

## 5. 验证

- API 单测：`node --test "apps/api/test/*.test.cjs" "apps/api/test/unit/**/*.test.cjs"`。
- 前端：`apps/web` 下 `npx vitest run --maxWorkers=2`（本机默认 4 worker 会 OOM）、
  `npm run test:lib --workspace=@dilee/web`、`npm run typecheck --workspace=@dilee/web`。
- `next build` 在本机因 V8 内存抖动无法完成（既有环境问题，与本轮改动无关），因此
  **web 侧没有生产构建产物**。
