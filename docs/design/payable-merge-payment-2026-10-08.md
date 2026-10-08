# 应付合并付款：同一供应商多笔应付（可跨订单）一次付款并真正核销（2026-10-08）

用户 2026-10-08：

> 「2.财务部分，请问现在支不支持，应付部分，同一个供应商的多个订单一起支付」

先是**问答**（答案：部分支持，见第 1 节）；查清之后用户把「合并付款」也排进了本轮，并且明确
要「已确认应付可多选、一次核销多条并回写应付状态/余额/银行流水」。

## 1. 改之前的两条线路（这就是「部分支持」的含义）

| 线路 | 界面入口 | 落库的东西 | 账面效果 |
|---|---|---|---|
| **付款单（打印件）**「集中付款单」/行内「付款单」 | ✅ 早就有 | `finance_slips` + `finance_slip_lines`（`finance-slip-store.service.ts:70-108`） | **无**：不写核销、不改应付状态、不动银行余额。它按「供应商 + 币种」把多条应付合到一张纸上（`finance-slip.ts:182-191`） |
| **供应商付款单 + 核销** | ❌ 界面零引用（`finance-sections.ts:193` 只剩旧地址重定向） | `supplier_payments` + `supplier_payment_allocations` + 应付状态 + `cash_flow_entries` | 全都有：核销行、`paid/partially_paid`、收支流水（含 `bankId` → 银行余额） |

后端**本来就支持**「同一供应商 + 同一币种、多条应付、跨多张订单」进一张付款单：
`post()` 的 `allocations` 是数组（`supplier-payment.service.ts:78-107`），而「同一订单」这条约束
**只在付款单自己带了 `order_no` 时才生效**：

```ts
// supplier-payment.service.ts:96
balance.entry.supplierId !== lockedPayment.supplierId
  || balance.entry.currency !== lockedPayment.currency
  || (lockedPayment.orderNo && balance.entry.orderNo !== lockedPayment.orderNo)
```

即「**付款单不写 `order_no`** ＝ 这一次付款可以核销多张订单的应付」。缺的只是界面，所以本轮**没有任何后端改动**。

## 2. 本轮改了什么（全在 web 侧）

| 文件 | 改动 |
|---|---|
| `payable-merge-payment-dialog.tsx`（新） | 纯函数（`isSettleable` / `settleAnchorOf` / `settleLockReasons` / `settleTotal` / `settleOutstandingTotal`）+ 弹窗：走真单据两步 `POST /finance/supplier-payments` → `POST /finance/supplier-payments/:id/post` |
| `payable-workspace.tsx` | 勾选放宽（草稿 **或** 可核销）；锚点式「供应商 + 币种」锁（逐行显示原因）；新增「未核销余额」列；新增「合并付款（N 条）」按钮；旧注释与 `aria-label`（「全选待确认应付」）改正 |
| 测试 | API 单测 `supplier-payment-service.test.cjs` +5（跨订单多笔核销、带 `order_no` 时拒绝跨订单、供应商/币种不符拒绝、超余额拒绝且**零核销行**、部分付款后再付清）；web `payable-page.test.tsx` +8（跨订单省略 `order_no`、同订单带上、逐行部分金额、超余额本地拦下不发请求、跨币种/跨供应商锁、过账失败留弹窗并复用同一张草稿） |

## 3. 语义（每条都由测试钉住）

- **金额的唯一真源是逐行「本次核销金额」**：表头「本次付款金额」是派生只读值，两者不可能各说各话。
  相加走**整数分**（`parseSlipAmount` / `formatSlipAmount`），不写浮点求和——这里的合计直接决定
  发出去的付款金额（`0.1 + 0.2 = 0.30000000000000004` 这种事不能出现在付款单上）。
- **供应商 + 币种是硬边界**：第一条可核销的应付是「锚点」，其它币种/供应商的行**复选框锁掉并把原因写在行上**，
  而不是让她勾完再吃一个 422。后端 `:96` 本来就拒绝，界面先拦是为了少一次往返、多一句人话。
- **银行账户必填**（比确认流程的「可选 + 警告」更严）：过账会把 `bankId` 写进收支流水，
  没有银行的付款不动任何账户余额（`supplier-payment.service.ts:127-129`），财务对不出账。
  **这是刻意的更严选择**，不是与确认流程口径不一致的疏漏。
- **`order_no` 只在所有勾选应付同属一个订单号时才写进付款单**（见第 1 节的开关语义）。
  注释写在弹窗文件头与 `submit()` 里，测试覆盖「跨订单省略 / 同订单带上」两种。
- **幂等与失败处理**：一次弹窗一个 `idempotency_key`；过账失败时草稿已经建出来了，
  界面必须点名它是哪张、并说明再提交会**复用同一张草稿**（不会重复建单），且核销合计不能超过草稿金额
  （否则用户会陷在「改了金额 → 一直报核销超过付款金额」的死循环里）。
- `subject_id` 只在建单时送（建单会校验存在且启用并落库）；过账的 `subject_id` 是「临时覆盖」入口，
  两处都送只会多一个能对不上的地方。

## 4. 未解决：台账「已付 / 未付」还是旧口径（本轮最重要的待定项）

`ledger-filter.ts:44` 把 `confirmed` 也算「已付」：

```ts
export const PAID_LEDGER_STATUSES = ["confirmed", "partially_paid", "paid"] as const;
```

这条口径来自「**确认即记账**」年代（注释里写着「界面上没有第二步付款，若把『已付』定义成
『有付款单核销』，那这个筛选项永远是空的」）。但 2026-09-24 的
`finance-accrual-two-step-2026-09-24.md` 已经把确认改成了**挂账**：
`supplier-payable.service.ts:204` 明写「确认那一刻钱还没付出，所以这一步**不写任何收支流水、不动任何银行账户**；
真正付款时在『登记付款』里记现金」。本轮又把第二步（真核销）接到了界面上。

**后果**：确认应付页默认的「未付」视图只列**草稿**，而「合并付款」要勾的 `confirmed` / `partially_paid`
全被默认筛掉（要切到「全部」）。本轮**没有改**这个口径，理由是它同时影响**应收**侧、
导出台账里的「付款情况」列（`ledger-workbook.ts:113`）、以及两个工作区约 6 个测试文件，
属于「改一次对方语义」的独立决定，应由用户拍板（另见 `docs/task/PENDING-USER-COMMITS.md`）。
本轮只在页面上给了一句实话提示（`payable-merge-hidden-hint`：还有 N 条已确认未结清的应付被当前筛选藏着，
切到「全部」就能勾选合并付款）。

建议的修法（下一轮）：`未付 = draft + confirmed + partially_paid`（钱还没付完／还没付），
`已付 = paid`，`partially_paid` 归「未付」因为还欠着钱；应收侧同一份文件同改（两边共用）。

## 5. 验证

- API 单测 `supplier-payment-service.test.cjs` **19/19**（原 14 + 5）。
- web `payable-page.test.tsx` **58/58**（原 50 + 8）；全量 web **lib 301 / components 1049**。
- 全量 API 单测 **2304/2304**；`typecheck` 双工作区干净；`next build` 通过。
- **本环境无法验证**：`finance-payable-chain.test.cjs`（集成）需要 Postgres，`finance-contract.test.cjs`（HTTP）
  需要跑起来的 API + admin 口令 —— 两者都没有，所以「真实过账确实改了台账与银行余额」只有
  服务层单测与请求契约作证，**没有端到端实测**。上线后第一次合并付款请人工核一次：
  应付状态 → 核销行 → 收支流水 → 银行余额四处是否一致。
