# W0 环境解阻 + 测试地基建 —— 执行结果

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 对应阶段：`docs/test/01-test-master-plan.md` §5.1 **W0**
- 环境：Windows 11 / PowerShell 5.1.22621 / Docker 29.7.2 / Node v24.15.0 / npm 11.12.1

---

## 1. 结论

**W0 达成**：链路三层（integration / http / e2e）从长期 `exit 3 TEST_BLOCKED` 变为**可执行**，前端组件测试工具链从零建立。

解阻后首次真正执行链路测试，立即暴露 **4 条集成用例陈旧失败**（见 §5）。它们不是本次改动引入的回归，而是"测试写完从未跑过"的直接证据。

---

## 2. W0 交付物

| # | 项 | 产物 | 状态 |
| --- | --- | --- | --- |
| S1 | 前端组件测试工具链 | `apps/web/vitest.config.mts`、`apps/web/test/setup.ts`、`apps/web/test/helpers/api-stub.ts`；devDeps：`vitest@5`、`@vitejs/plugin-react@6`、`jsdom@30`、`@testing-library/react@16`、`@testing-library/user-event@14`、`@testing-library/jest-dom@7`、`@vitest/coverage-v8@5`、`msw@2` | ✅ 已跑通 |
| S2 | 测试数据库隔离 | `scripts/provision-test-databases.mjs`、`tests/helpers/test-databases.cjs` | ✅ 4 个 worker 库各 80 表 / 63 迁移 |
| S5 | CI 测试接线 | `.github/workflows/test.yml`（fast + chain）；`.github/workflows/deploy.yml` 补 `test:unit` | ✅ |
| S7 | 覆盖率与报告 | `test:coverage` / `test:coverage:api` / `test:coverage:web` | ✅ 后端 77.29% 行覆盖基线 |
| S8 | 环境解阻 | `scripts/dev-test-up.ps1`、`docs/test/02-test-environment-runbook.md` | ✅ 一条命令 exit 0 |
| — | 脚本重接线 | `package.json`：`test` / `test:unit` / `test:unit:api` / `test:unit:web` / `db:test:provision` | ✅ |
| — | Playwright 跨平台 | `playwright.config.mjs` 的 `webServer.command` 按 `process.platform` 分支 | ✅ 原先仅 Windows 可用 |

### 新增测试用例（12 条）

| 文件 | 用例 | 覆盖维度 |
| --- | --- | --- |
| `apps/web/test/toolchain-smoke.test.tsx` | 4 | 工具链自检（渲染 / 事件 / jest-dom / fetch 桩） |
| `apps/web/test/action-dialog-submit-guard.test.tsx` | 8 | **防重复提交**：必填校验、trim、提交中禁用与文案、连点只提交一次、关闭门禁、成功回调、失败恢复、多选提示语 |

> `components/ui/action-dialog.tsx` 是全站**唯一**同时守卫输入/按钮/弹窗关闭的组件，此前**零测试**。它一旦回归，全站表单会同时出现重复提交与"弹窗关不掉"。

---

## 3. 实跑证据

| 命令 | 结果 | 退出码 | 耗时 |
| --- | --- | ---: | ---: |
| `npm run typecheck` | 通过（含新增测试文件） | 0 | — |
| `npm run test:unit` | **535 通过 / 0 失败** | **0** | — |
| ├ `test:unit:api` | 415 通过 | 0 | 5.3s（不含 build） |
| ├ `test:unit:web` → `test:lib` | 108 通过 | 0 | 0.5s |
| └ `test:unit:web` → `test:components` | 12 通过 | 0 | 3.6s |
| `npm run test:coverage:api` | 行 77.29% / 分支 61.66% / 函数 68.30% | 0 | — |
| `npm run test:coverage:web` | 行 2.77%（仅 2 个测试文件，属预期起点） | 0 | 4.5s |
| `npm run test:api` | **10 通过 / 0 失败** | 0 | 0.5s |
| `npm run test:integration` | **2 通过 / 4 失败** | 1 | 1.4s |
| `npx playwright test tests/e2e/authentication.spec.mjs` | **2 通过 / 0 失败** | 0 | 8.2s |
| `npm run db:test:provision --workers 4` | 模板库 + 4 worker 库，各 80 表 / 63 迁移 | 0 | — |
| `scripts/dev-test-up.ps1 -Workers 2` | 端到端成功 | 0 | — |

### 解阻前后对比

| 层 | 解阻前 | 解阻后 |
| --- | --- | --- |
| integration | `TEST_BLOCKED: TEST_DATABASE_URL is required`（exit 3） | **已执行**：2/6 通过 |
| http | `TEST_BLOCKED: API_BASE_URL is required`（exit 3） | **已执行**：10/10 通过 |
| e2e | `TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required`（exit 3） | **已执行**：authentication 2/2 通过 |

---

## 4. 顺带修复的既有测试缺陷

在让集成测试真正跑起来的过程中，修复了 3 处**用例自身**的缺陷（均为陈旧或笔误，非生产代码问题）：

| 文件 | 缺陷 | 修复 |
| --- | --- | --- |
| `apps/api/test/integration/procurement-inbound.test.cjs:30,68` | `notice` 用 `const` 声明在 `try` 内、却在 `finally` 里引用 → `ReferenceError`。**该用例从未真正执行过** | 提升为 `try` 外声明，并在清理处加空值保护 |
| `apps/api/test/integration/production-daily-reports.test.cjs` | 固定使用 2026-08-21（早于运行日），未声明补录原因 → 422 `BACKFILL_REASON_REQUIRED` | 3 处工序日报补 `remark`（服务端规则正确，用例需遵守） |
| `apps/api/test/integration/production-order.test.cjs:31` | 同一销售订单二次建主生产单 → 409 `PRODUCTION_ORDER_ALREADY_EXISTS` | 改为 `production_order_type: "supplement"` + `parent_production_order_id`（符合"一单一张主生产单"规则） |

---

## 5. 遗留：4 条集成用例陈旧（列入 P3）

修复上述 3 处后，更早的断言得以执行，暴露更深一层陈旧。**这些属于集成测试内容（P3），不在 W0 脚手架范围。**

| # | 用例 | 失败点 | 根因 |
| --- | --- | --- | --- |
| 1 | `procurement.inbound.post_generates_inventory_and_a_single_payable_source` | `INBOUND_NOTICE_NOT_ACKNOWLEDGED`（422）于 `raw-material-inbounds.service.ts:140` | 入库过账新增「仓库须先接收入库通知」前置。用例创建的 `rawMaterialInboundNotice` 未与 `rawMaterialInbound` 建立关联，`inbound.inboundNotice` 为空 |
| 2 | `production.daily-reports.calculates-progress-payroll-and-alert-lifecycle` | `assert.equal(await prisma.productionPayrollSource.findFirst(...), null)` 断言失败 | 「删除日报后薪资来源应消失」的断言与当前实际生命周期语义不符（删除后来源仍以未删除状态存在） |
| 3 | `production.order.creates_from_confirmed_order_and_requires_operations_before_start` | `assert.rejects(... PRODUCTION_OPERATIONS_REQUIRED)` 未抛出 | `production-orders.service.ts:37` 现自动追加「包装」收尾工序，故新建生产单已有工序，该守卫不再触发 |
| 4 | `production.order.operation.target-and-unit.patchable-with-lock-and-validation` | `PRODUCTION_OPERATION_SEQUENCE_DUPLICATE`（409） | 同上：自动追加的包装工序占用 `sequence_no = 1`，与用例手工 `addOperation(sequence_no: 1)` 冲突 |

**结论**：这 4 条用例写于「包装工序自动追加」与「入库通知关联」两项特性之前，且因环境长期阻断从未回归。修复它们需要按当前领域规则重写夹具与断言 —— 属 P3。

---

## 6. 环境层发现（已写入 Runbook）

| 现象 | 真因 | 处理 |
| --- | --- | --- |
| `next build` 报 `Zone Allocation failed - process out of memory`，但堆仅 9-30 MB、物理内存剩 10.6 GB | **`.next` 缓存损坏**，非真实内存不足 | 删除 `apps/web/.next` 后同一命令一次通过（22 条路由） |
| `.ps1` 含中文即解析失败 | PowerShell 5.1 把无 BOM 的 UTF-8 按系统 ANSI 读取（本仓库无 `pwsh`，只有 `powershell` 5.1） | 脚本存为 UTF-8 **with BOM**，并加 `Parser::ParseFile` 语法自检 |
| Prisma 输出被判为 PowerShell 错误 | Prisma 进度写 **stderr**，PS 视为错误记录 | 判断成败看 `$LASTEXITCODE` |
| Linux CI 上 Web 无法启动 | `playwright.config.mjs` 硬编码 Windows `xcopy` | 按 `process.platform` 分支 |

---

## 7. 下一步

W0 已完成，建议进入 **W1**（地基 B）：

- S3 夹具工厂库（14 个工厂方法，替换各集成/E2E 用例手写的 Prisma 播种）
- S4 测试用户与 RBAC 种子（解除 401/403/权限维度的测试阻塞）
- S9 契约测试 harness（扩充 `tests/helpers/api-client.cjs`：Cookie 会话、`x-request-id` 断言）
- S10 跨模块不变量补全（金额/余额、状态机、幂等、冲销保留原事实）

同时建议把 §5 的 4 条陈旧集成用例并入 **P3 首批**，因为 CI `chain` 门禁会因此保持红色。
