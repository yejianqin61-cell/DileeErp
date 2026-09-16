# 工资付款的发放银行 + 原料出库的仓库确认（2026-09-16）

> 用户原文（三条）：
> 1. 「工资支付那边也是全部要加上银行账户，因为发工资都是要用银行账户发放的工资。」
> 2. 「生产模块，生产领料单，条目，双击条目，弹出居中悬浮窗口，展示本条领料单所有的领用的物料。」
> 3. 「生产领料单已确认，仓库那边不能直接原料出库，要有一个待确认的地方，确认过后才能原料出库，
>    进行原料仓储的流转。因此仓库页面，再多一个待出库通知的地方。」

## 1. 排查结论

| # | 事实 | 证据 | 后果 |
| --- | --- | --- | --- |
| A | **工资付款没有银行账户** | `SalaryPayment` 模型只有 `paymentMethod`/`bankReference`，没有 `bank_id`；`SalaryPaymentService.post` 调 `autoCreateFromPayment` 时只给 `settlementMethod`，`bankId` 为空 | 工资这笔支出写进了收支流水却**不属于任何银行账户**，因此不进任何账户余额：银行余额与真实银行账永久差一笔工资（上一轮 D2 的「没指定账户的流水不进余额」在这里变成了系统性缺口，而不是历史数据问题） |
| B | **领料单草稿直接过账 = 生产单方面扣库存** | `RawMaterialMovementsService.postOutbound` 的准入是 `status === "draft"`，通过后立刻写 `inventoryFact`（`quantityDelta` 取负） | 仓库连一张单都没看到，原料库存已经少了；「仓库确认出库」这一步在系统里根本不存在 |
| C | **领料单没有详情入口** | 生产单详情页与「领料单 / 补料单」列表都只给一张汇总行（`N 项 / 合计 X`），没有双击查看 | 想看「这张单到底领了哪些料、各多少」只能靠导出 Excel 或去数据库查 |
| D | **仓库页只有「待入库通知」** | `apps/web/app/warehouse/page.tsx` 只拉 `/raw-material-inbound-notices` | 仓库没有任何地方能看到「有哪些领料要出」 |

## 2. 决策

- **D1 工资付款的发放银行是**必填**，不是可选**。理由就是用户给的那句：发工资都是走银行发放的。
  可选会重演 A 的后果 —— 一笔支出写进了流水却不属于任何账户，而这次没有任何「历史数据」可以当借口。
  校验与收付款/对账共用同一套 `requireActiveBank`（存在 + 未删除 + **未停用**；外键拦不住「停用」，
  只靠前端下拉过滤也不够，接口可以被直接调用）。缺银行 → 422 `SALARY_PAYMENT_BANK_REQUIRED`。
- **D2 校验放在建单之前**。`payLedger` 是「生成工资应付 → 确认应付 → 建付款 → 核销过账」四步编排：
  如果走到一半才发现银行非法，会留下一张刚生成的工资应付要人工清理。因此银行校验是第一步。
- **D3 原料出库改两段式**：`draft`（草稿）→**生产「确认提交」**→ `pending_outbound`（待仓库出库）
  →**仓库「确认出库」**→ `posted`（写 `inventoryFact`，库存真正扣减）。
  核心不变式：**只有 `pending_outbound` 能被出库**。草稿直接过账一律 422，并在错误信息里写明「请先由生产确认提交」。
- **D4 不另建「出库通知」表**。这张领料单本身就是通知：单据号、生产单、订单号、物料明细、数量全在里面。
  另建影子表只会让两张表的状态互相漂移（通知说待出库、单据说已出库）。因此「待出库通知」=
  `raw_material_movements where status = 'pending_outbound'`，一个查询，一个事实来源。
- **D5 提交时就校验库存，出库时再校验一次**。提交时校验是为了让生产**当场**知道这批料领不出来
  （而不是等仓库点确认时才失败，那时人已经离开了）；出库时仍在事务内用同一套 `previewLines` 再校验，
  因为两次之间库存可能被别的单据改变。
- **D6 撤回提交 = `pending_outbound` → `draft`，不写冲抵事实**。这时还没有任何 `inventoryFact`。
  没有这一步的话，生产填错数量提交之后就再也改不了，只能等仓库照错单出库。
  已过账的回退草稿仍是原来的逻辑（写等额冲抵事实），两条路径共用一个 `reopen` 接口，都要求填原因。
- **D7 补料单同规则**。它同样是原料出库（`sourceType = material_replenishment`），
  「生产不能自己决定扣仓库的料」这条理由对它一样成立；一份代码（`postOutbound`）同时管两者，
  只让领料单走确认、补料单绕过，等于给仓库留了一个后门。
- **D8 `submittedAt` 单独一列，不复用 `updatedAt`**。`updatedAt` 会被任何一次写入改动
  （备注、编辑、审计），而待出库通知要显示的是「这张单什么时候交过来的」，两次提交之间不能漂移。
- **D9 通知按提交时间**正序**排**。仓库按先来后到处理，而不是每次都先看到最新那张。

## 3. 改动清单

### 3.1 数据模型（迁移 `20260916130000_salary_bank_and_material_outbound_confirm`）

| 对象 | 变化 | 关键点 |
| --- | --- | --- |
| `salary_payments` | `+ bank_id UUID` | 可空列只为兼容升级前的历史单据；**新建/过账由服务层强制要求**。可空关联 → `ON DELETE SET NULL` |
| `raw_material_movements` | `+ submitted_at TIMESTAMP(3)` | 生产确认提交的时刻；撤回时清空 |
| `raw_material_movements` | `+ (status, submitted_at)` 索引 | 「待出库通知」的查询路径；缺索引会让每次打开仓库页全表扫流转单据 |

`status` 新增 `pending_outbound` **不需要改库结构**：该列是 `VARCHAR(30)`，且这张表没有 `status` 的
CHECK 约束（见 `20260822113000_raw_material_issue_movements`）。守卫测试
`salary-bank-and-outbound-migration.test.cjs` 专门盯住这一点 —— 本机跑不了真实迁移，
如果将来有人给 `status` 加了 CHECK，`pending_outbound` 会被库层拒绝，那条断言就是防线。

### 3.2 API

- **`RawMaterialMovementsService`**
  - `submitOutbound(id, user)`（新）：`draft → pending_outbound`，写 `submittedAt`，**不写任何库存事实**；
    校验库存与明细；只有 `issue`/`replenishment` 可以提交。
  - `postOutbound(...)`：准入从 `draft` 改为 `pending_outbound`；事务内的状态复查同步收紧。
  - `reopen(...)`：新增 `pending_outbound → draft` 分支（撤回提交，清空 `submittedAt`，审计
    `raw_material_movement.withdraw`）；`posted` 分支保持原样。
  - `pendingOutbound()`（新）：待出库通知清单，只列 `issue`/`replenishment`，按 `submittedAt` 正序。
- **`RawMaterialMovementsController`**：新增 `POST :id/submit` 与 `GET pending-outbound`。
  `pending-outbound` 必须声明在 `@Get(":id")` **之前**（Nest 按声明顺序匹配，否则会被当成单据 id）。
- **`SalaryPaymentService`**：`create`/`payLedger` 必填发放银行（`requireBank`，422
  `SALARY_PAYMENT_BANK_REQUIRED` / 404 `BANK_NOT_FOUND`）；`updateDraft` 支持改/清空（`null` = 清空，
  `undefined` = 不改）；`post` 过账前再次要求一个可用银行，并把 `bankId` 写进收支流水。
- **`hr.controller.ts`**：`PayLedgerDto` / `PaymentDto` / `SalaryPaymentUpdateDto` 加 `bank_id`。

### 3.3 前端

- `components/production/material-issues-panel.tsx`、`app/production/material-issues/page.tsx`、
  `components/production/material-slip-editor.tsx`：**双击条目弹出居中悬浮详情窗**，列出本条领料单
  **全部领用物料**（物料编码 / 名称 / 规格型号 / 单位 / 数量 / 备注）；行动作改为
  「确认提交」（→ `submit`）／「撤回提交」（→ `reopen`）／`pending_outbound` 显示「待仓库出库」。
- `app/warehouse/page.tsx`：新增「待出库通知」面板（`GET /production/material-movements/pending-outbound`），
  行内「确认出库」走 `post` / `post-replenishment`（`postMovementPath` 已按单据类型分流）。
- `components/finance/salary-workspace.tsx`：工资台账的行内付款、工资付款建单/编辑草稿全部加
  **发放银行**（必填，只列启用账户，来自 `GET /finance/banks`），付款表加「发放银行」列。

## 4. 已知缺口（本轮未做）

1. **出库没有「部分出库」**：仓库确认即整单出库。实际领料常有缺料（只到了 8 个、要分两次出），
   目前只能改数量后重新提交。要不要做分次出库需要业务确认（会牵出「领料单剩余量」这个新概念）。
2. **待出库通知没有提醒/推送**：仓库不进页面就不会知道有单等着（与「待入库通知」现状一致）。
3. **升级前已过账的领料单不受影响**：它们已经是 `posted`，库存事实早已写好，不需要补确认。
4. **升级前的工资付款草稿 `bank_id` 为空**：过账时会被 422 拒绝（这是有意的 —— 宁可挡住，
   也不产生一笔不属于任何账户的支出）。需要在付款草稿上补一个发放银行再发放。
5. **本机没有 PostgreSQL**：迁移未在真实库上执行过；守卫测试只做静态断言。
6. **出库确认没有权限区分**：「谁能确认出库」目前仍是 `production` 模块权限，
   仓库与生产在同一个模块权限下，没有单独的角色门禁。

## 5. 人工验收步骤

1. **工资付款**：财务 → 银行账户建一个账户 → 工资管理 → 工资台账行内点「付款」，
   不选发放银行应被挡住（提示去建账户）；选一个账户后发放 →
   收支明细表出现这笔工资支出且**带出该银行账户** → 银行余额相应减少 → 冲销工资付款后余额复原。
2. **领料单两段式**：生产单详情「生产领料单」→ 新建领料单（草稿）→ 点「确认提交」→
   状态变「待仓库出库」，库存**不变**；点「撤回提交」（填原因）→ 回到草稿且可继续编辑。
3. **仓库确认出库**：仓库首页新增的「待出库通知」出现该单据（含生产单号、订单号、物料明细、提交时间）→
   点「确认出库」→ 原料库存真正扣减、原料仓储情况的库存数变化 → 该单从待出库通知消失、状态变「已过账」。
4. **双击查看领用物料**：在领料单列表与生产单详情面板双击任意一行 → 弹出居中悬浮窗，
   列出这张单**全部**领用物料的编码 / 名称 / 规格型号 / 单位 / 数量 / 备注。
5. **补料单同规则**：新建补料单 → 同样需要「确认提交 → 仓库确认出库」，不能从生产侧直接出库。

## 6. 验证

- API 单测：`node --test "apps/api/test/*.test.cjs" "apps/api/test/unit/**/*.test.cjs"`。
- 前端：`apps/web` 下 `npx vitest run --maxWorkers=2`、`npm run typecheck --workspace=@dilee/web`。
- `next build` 在本机因 V8 内存抖动无法完成（既有环境问题），因此 web 侧没有生产构建产物。
