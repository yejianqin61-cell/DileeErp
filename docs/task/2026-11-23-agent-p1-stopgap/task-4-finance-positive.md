<task-brief>

## 1. Where this task sits

- **Phase P1 止血**，目标之一是把 P0 的三个盲区验掉。
- **本任务交付 R-4 正向财务路径验证**：证明 `full` 档位真的能读到财务事实，而不只是「operational 读不到」。
- **Starts after**：无。**Waits on it**：任务 6（报告里要写这一栏）。

## 2. What the developer needs to know

**Read first**

- `scripts/bootstrap-permission-accounts.mjs` — 已存在，会建 `laoban1/laoban2/caiwu` 等账号，初始密码只在新建时打印一次。
- `apps/api/src/modules/business-query-agent/access-level.ts` — `full` 只认 `laoban` / `caiwu` 两个角色 key；`administrator` 只是 `operational`。
- `apps/api/test/agent-golden/cases/permission-finance.json` — 现在的 5 条是**负向**断言，本任务补的是正向那一半。
- `scripts/seed-mock-data.mjs` — `MOCK-AR-001` 应收、`MOCK-AP-001` 应付，都挂在 `MOCK-ORD-001`。

**Settled**

- 正向用例用 `laoban1` 账号跑，断言来源里**出现**财务类 `business_type`（`receivable_source` / `supplier_payable_entry`）。
- 负向那 5 条不改：它们证明的是档位隔离，正向证明的是档位可用。两条一起才构成「档位真的生效」。
- 账号密码不写进仓库：评测脚本从 env 读（`GOLDEN_FULL_USERNAME` / `GOLDEN_FULL_PASSWORD`）。

**Edges and seam**

- 新增 `apps/api/test/agent-golden/cases/finance-positive.json`；`scripts/agent/golden-eval.mjs` 支持按组切换账号。
- 不改 `apps/api/src`。

**Run**

- `node scripts/bootstrap-permission-accounts.mjs`（本地库，只建缺失账号）
- `npm run test:agent-golden -- --group finance_positive`（需要 `GOLDEN_FULL_PASSWORD`）

**Unknowns**

- 若 bootstrap 脚本判定账号已存在而跳过，就拿不到密码 —— 这会让本任务卡住。届时停下来报告，让用户重置该账号密码，不要自己改库里的哈希。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 跑 bootstrap 建账号，记下打印出来的初始密码（只在本地 env 用）。
3. 写 `finance-positive.json` 4 条：应收、应付、成本利润、对账，全部以 `MOCK-ORD-001` 为根。
4. 给评测脚本加 `GOLDEN_FULL_USERNAME` / `GOLDEN_FULL_PASSWORD`，与该组绑定。
5. 真机跑该组，确认来源里出现财务类 `business_type`。
6. 把结果写进任务 6 的报告，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `laoban1` 问应收 | 来源含 `receivable_source`，终态 `completed` | `judge()` |
| 2 | `laoban1` 问应付 | 来源含 `supplier_payable_entry` | `judge()` |
| 3 | `laoban1` 问成本利润 | 终态 `completed`，无 `AGENT_TOOL_FORBIDDEN` | `judge()` |
| 4 | `administrator` 问同一句（对照组） | 来源里**不**含财务类型 | `judge()` |
| 5 | 缺 `GOLDEN_FULL_PASSWORD` | 脚本明确报错退出，不静默跳过该组 | `main()` |

</task-brief>