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

## 4. 台账「已付 / 未付」口径：已按用户决定改掉（2026-10-08 第二轮）

**问题（第一轮结束时发现）**：`ledger-filter.ts` 把 `confirmed` 也算「已付」：

```ts
export const PAID_LEDGER_STATUSES = ["confirmed", "partially_paid", "paid"] as const;   // 旧
```

这条口径来自「**确认即记账**」年代（注释里写着「界面上没有第二步付款，若把『已付』定义成
『有付款单核销』，那这个筛选项永远是空的」）。但 2026-09-24 的
`finance-accrual-two-step-2026-09-24.md` 已经把确认改成了**挂账**：
`supplier-payable.service.ts:204` 明写「确认那一刻钱还没付出，所以这一步**不写任何收支流水、不动任何银行账户**；
真正付款时在『登记付款』里记现金」。紧接着本轮又把第二步（真核销）接到了界面上 —— 前提彻底不成立了。

**后果**：确认应付页默认的「未付」视图只列**草稿**，而「合并付款」要勾的 `confirmed` / `partially_paid`
全被默认筛掉（要切到「全部」）——功能做出来了，目标数据却藏在另一个筛选档里。
第一轮没有擅自改：它同时影响**应收**侧、导出台账的「付款情况」列与约 6 个测试文件，
属于「改一次对方语义」的决定，交回用户拍板，并在页面上先给了一句实话提示。

**用户 2026-10-08 拍板「可以」，第二轮已实施**：

```ts
export const UNPAID_LEDGER_STATUSES = ["draft", "confirmed", "partially_paid"] as const;
export const PAID_LEDGER_STATUSES = ["paid"] as const;
```

- **未付/未收 = 草稿 + 已确认 + 部分付款**（草稿还没挂账、已确认只挂了账、部分付款还欠着钱）；
  **已付/已收 = 已付清/已收清**；作废/冲销仍只在「全部」里出现。
- `paymentBucket` 改为由上面两个集合推出（不另抄一份状态名），集合与函数不会再各自漂移。
- 改动面：`ledger-filter.ts` + web 侧同口径镜像 `finance-ledger-filter.ts`；
  导出台账的「付款情况 / 收款情况」列与脚注（`ledger-workbook.ts`）；控制器参数注释；
  「确认应付」页那条 `payable-merge-hidden-hint` 提示与它的派生状态一并删除（前提消失）。
- **应收侧一并改**：收款情况与付款情况共用同一份口径文件与同一个 `payment` 参数，只改一半会自相矛盾。
- **预期效果**：现有数据下「未付/未收」计数变大（已确认的从已付档移入），界面与导出条数同步变化；
  默认视图现在就能勾选合并付款。
- 顺手修了 4 处仍在教旧口径的方法注释（`receivable.service` / `supplier-payable.service` 的
  「确认即记账」标题，以及两条对账单批量确认路径的同款说明）。复核确认那两条对账单路径实际调用的
  也是 `createAccrual`（挂账），**不存在「一条路径挂账、另一条路径记现金」的分裂**。

## 5. 验证

- API 单测 `supplier-payment-service.test.cjs` **19/19**（原 14 + 5）。
- web `payable-page.test.tsx` **58/58**（原 50 + 8）。
- 第二轮（台账口径）之后的**最终**门禁：全量 API 单测 **2308/2308**；web **lib 302/302 + components 1049/1049**；
  `typecheck` 双工作区干净；`test:deploy` 32/32；`next build` 通过。
- **本环境无法验证**：`finance-payable-chain.test.cjs`（集成）需要 Postgres，`finance-contract.test.cjs`（HTTP）
  需要跑起来的 API + admin 口令 —— 两者都没有，所以「真实过账确实改了台账与银行余额」只有
  服务层单测与请求契约作证，**没有端到端实测**。上线后第一次合并付款请人工核一次：
  应付状态 → 核销行 → 收支流水 → 银行余额四处是否一致。
