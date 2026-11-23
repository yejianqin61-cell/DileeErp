# 结算方式新增两个账户（2026-11-23 / T-0027）

> 用户原话：「把系统结算方式改下，加入中国银行-人民币账户，还有备用金（招商银行账户）」

## 1. 先确认「结算方式」在本系统指什么

收支流水上给人看的「结算方式」是两段拼出来的：

| 段 | 存储 | 例子 |
| --- | --- | --- |
| 方式 / 业务类型 | `cash_flow_entries.settlement_method`（自由文本） | `转账`、`现金`、`备用金报销` |
| 结算账户 | `cash_flow_entries.settlement_account_id` → `dictionary_items`（`dictionary_types.key='settlement_account'`） | `农业银行5706`、`中国银行（美元）7624` |

用户给的两个名字（「中国银行-人民币账户」「备用金（招商银行账户）」）都是**账户名**，只需要一个名字即可录入，
正好落在结算账户字典上。**没有**动银行账户池（`banks`）：那一侧建一户要银行编码、开户行、账号、账户名、币种，
用户没有给这些信息，不能擅自造主数据；两套东西的区别见 `bank-account-pool-page-2026-09-15.md` §D4。

## 2. 改动

| 文件 | 改什么 |
| --- | --- |
| `apps/api/src/modules/finance/cash-flow-catalog.ts` | 把老表 2 项冻结为 `LEGACY_SETTLEMENT_ACCOUNTS`（迁移守卫用）；`DEFAULT_SETTLEMENT_ACCOUNTS` 扩为 4 项：老 2 项 + `中国银行-人民币账户` + `备用金（招商银行账户）` |
| `apps/api/prisma/seed.ts` | 不改代码：本来就复用 `DEFAULT_SETTLEMENT_ACCOUNTS`，新库 / 重跑 seed 会自动种入 4 项 |
| `apps/api/test/unit/cash-flow-migration.test.cjs` | 迁移检查改用冻结的历史清单；新增「当前清单含两项新账户、排序 10/20/30/40」断言 |
| `apps/web/lib/finance-sections.ts` | 财务一级页新增「结算方式」板块（`/finance/settlements`） |
| `apps/web/lib/settlement-accounts.ts` | 前端内置清单副本 + 「库里有 / 已停用 / 缺失」对照 |
| `apps/web/components/finance/settlement-account-workspace.tsx` | 结算账户列表、搜索、新增、编辑、停用/启用、补齐缺失内置项 |
| `apps/web/app/finance/settlements/page.tsx` | 二级页路由 |
| `apps/web/test/settlement-account-page.test.tsx` | 8 条页面行为测试 |
| `apps/web/test/finance-page.test.tsx` | 财务一级页入口从 9 个改为 10 个 |

## 3. 为什么没有新增 migration，以及已有库怎么补数据

仓库红线：**不执行 prisma migrate、不新增/修改 `prisma/migrations` 下的文件、不直接写生产库**。
所以没有为这两项新增迁移，也不能由 Agent 直接把数据写进生产库。

补齐路径（二选一，均由人工 / 部署侧执行）：

1. 部署后打开 **财务 → 结算方式**，点「补齐缺失的内置账户」：只对字典里**完全没有**的内置项发
   `POST /dictionaries/settlement_account/items`；已停用项不复活、已改名的按 key/label 认作已存在。
2. 或在部署环境执行一次 `npm run db:seed --workspace=@dilee/api`（seed 是 upsert，幂等）。

新库 / 执行过 seed 的库：`GET /dictionaries/settlement_account/items` 会直接返回 4 项，
收支流水表单的「结算账户」下拉随即出现两项新账户。

## 4. 验证

- `apps/api/test/unit/cash-flow-migration.test.cjs`：9 条通过（含新增的目录断言）；
- `apps/web/test/settlement-account-page.test.tsx`：8 条通过（列表/内置缺项/补齐请求体/搜索/新增/编辑/停用）；
- `npm run typecheck`（三 workspace）：见当日日志；
- 未跑全量测试（机器 2 核，按工单要求只跑相关文件）。

## 5. 风险与未验证

- **已有生产库不会因为代码合并就自动多出两行**：必须执行上面的补齐按钮或 seed；这是本次唯一的人工步骤。
- 结算账户字典与银行账户池没有外键关系：新账户只影响收支流水的「结算账户」文本与凭证资金科目名后缀，
  不参与任何余额计算；如果财务要让它参与余额，需要另外建 `banks` 主数据并提供账号。
- 页面与接口未在真实 PostgreSQL 上做端到端验证（本机无可用测试库）。
