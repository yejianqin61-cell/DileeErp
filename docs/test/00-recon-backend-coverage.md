# 后端测试覆盖缺口报告（Backend Test Coverage Gap Report）

- 审计对象：`apps/api`（NestJS + Prisma），测试形态为 Node 原生 `node --test` + CommonJS `.test.cjs`
- 审计基线提交：`c916059`（`git rev-parse --short HEAD`），提交时间 2026-09-12T22:13:32+08:00
- 审计执行时间：2026-09-13
- 审计方法：静态清点（文件/装饰器/`dist` 引用解析）+ 本地可运行测试实跑（`node --test`，不执行 `build`，直接复用既有 `apps/api/dist`）
- 审计范围外：`apps/web` 前端测试（仅在「偏差」一节中作为对照提及）、Playwright 浏览器断言细节、性能/备份恢复
- 本文所有数字均为本次实测值；无法验证的内容一律标注 **未验证**

---

## 0. 结论摘要

1. **本地可运行测试全绿，但全部集中在服务层 + 伪 Prisma**：`node --test apps/api/test/unit/*.test.cjs` → 271 pass / 0 fail；`node --test apps/api/test/*.test.cjs` → 144 pass / 0 fail。共 415 个用例通过，**零真实数据库参与**。
2. **真实数据库 / HTTP / 浏览器三层在当前环境下全部环境阻断**：`TEST_DATABASE_URL`、`API_BASE_URL`、`PLAYWRIGHT_BASE_URL` 三个变量在审计环境中均为空，`docs/test/results/latest-chain-quality-gate.md:9-12` 记录四项链路门禁全部以退出码 3（环境阻断）结束。
3. **352 个 HTTP 端点中，333 个（94.6%）没有任何 HTTP 层测试**；被 HTTP 测试触及的 19 个端点里，只有 3 个有正向断言（`GET /api/v1/health`、`POST /api/v1/auth/login`、`GET /api/v1/sales-orders`），其余 16 个只断言匿名 401。
4. **57 个生产产物被测试直接 `require`，77 个未被任何测试引用**（134 个 `.ts` 文件中）。其中业务性缺口最严重的是：`modules/reports/reports.service.ts`、`modules/alerts/alerts.service.ts`、`platform/forms/*`、`platform/attachments/*`、`platform/dictionaries/*`、`platform/state-machine/state-machine.service.ts`、`platform/authorization/module-permission.guard.ts`、`platform/http/response-envelope.interceptor.ts`。
5. **测试只验证「服务方法 + 手写假 Prisma」这一种接缝**：没有任何测试装配 Nest 模块（全仓库 `@nestjs/testing` 零引用），也没有任何测试对控制器/守卫/拦截器做端到端装配验证。
6. **零真实并发测试**：所有 `*-lock` 类测试只是断言「假 Prisma 的 `$queryRaw`/`$executeRaw` 被调用了一次」，不产生真实并发事务。

---

## 1. 概览

### 1.1 生产代码规模

| 指标 | 数量 | 依据 |
| --- | ---: | --- |
| `apps/api/src` 下 `.ts` 文件 | 134 | `Get-ChildItem -Recurse -Filter *.ts` |
| 物理行数（含空行） | 10,202 | `(Get-Content).Count` 累加 |
| 非空行数 | 9,484 | `Measure-Object -Line` 累加 |
| `src/modules` | 88 文件 / 9,215 行 | — |
| `src/platform` | 42 文件 / 903 行 | — |
| `src` 根（`main.ts`/`app.module.ts`/`health.controller.ts`/`build-info.ts`） | 4 文件 / 84 行 | — |
| 业务模块目录数 | 10（`modules/*`） | `customers` 目录下只有 `README.md`，无代码 |
| 平台目录数 | 12（`platform/*`） | — |
| Controller 文件 | 37 | `*.controller.ts`（modules 30 + platform 6 + `health.controller.ts` 1） |
| Service 文件 | 46 | `*.service.ts`（modules 38 + platform 8） |
| **HTTP 端点** | **352** | 解析 `@Get/@Post/@Patch/@Put/@Delete` 并与 `@Controller` 前缀 + 全局前缀 `api/v1`（`src/main.ts:14`）拼接 |
| DTO **文件** | 1 | `src/platform/http/pagination-query.dto.ts` |
| DTO **类** | 148 | `grep 'class \w+Dto'`；除 4 个导出类（`procurement-master-data.controller.ts:13,14,20`、`customers.controller.ts:14`、`sales-orders.controller.ts:20,46`）与 `pagination-query.dto.ts:4` 外，**其余全部以内联非导出类写在 controller 文件里** |
| Guard | 2 | `platform/authorization/authentication.guard.ts`、`platform/authorization/module-permission.guard.ts` |
| 领域/纯函数文件 | 11 个 `*.domain.ts` + `packaging-operation.ts`、`daily-report-alerts.ts`、`finished-goods-inbound-notice-status.ts`、`finished-goods-settlement.ts`、`daily-sequence-code.ts`、`module-key.ts` | — |

### 1.2 测试代码规模

| 指标 | 数量 |
| --- | ---: |
| 测试文件总数 | 77 |
| `apps/api/test/*.test.cjs`（root「领域」层） | 19 |
| `apps/api/test/unit/**` | 48 |
| `apps/api/test/http/**` | 5 |
| `apps/api/test/integration/**` | 5 |
| 测试代码物理行数 | 7,324 |
| 测试用例（`test(` / `it(`） | 431 |
| 其中：本地可运行（root + unit） | 415（144 + 271），**本次实跑全部通过** |
| 其中：HTTP 层 | 10（环境阻断，未实跑） |
| 其中：integration 层 | 6（环境阻断，未实跑） |
| 共享 helper / fixture | 5 个文件（`tests/helpers/*.cjs` 3 个、`tests/fixtures/*.cjs` 2 个），共 60 行 |
| `apps/api/test/helpers/migration-guards.cjs` | 1 个（3,022 B），供 3 个迁移守卫测试使用 |

### 1.3 覆盖率分层实数

| 层级 | 文件数 | 用例数 | 是否使用真实 Prisma | 本次是否实跑 | 结果 |
| --- | ---: | ---: | --- | --- | --- |
| root（`apps/api/test/*.test.cjs`） | 19 | 144 | 否（全部手写假 Prisma / 纯函数） | 是 | 144 pass / 0 fail |
| unit（`apps/api/test/unit/**`） | 48 | 271 | 否 | 是 | 271 pass / 0 fail |
| http（`apps/api/test/http/**`） | 5 | 10 | 否（`fetch` 打真实 API） | 否 | 环境阻断（`API_BASE_URL` 为空） |
| integration（`apps/api/test/integration/**`） | 5 | 6 | **是**（`new PrismaClient({ datasources: { db: { url: requireTestDatabaseUrl() } } })`） | 否 | 环境阻断（`TEST_DATABASE_URL` 为空） |

> 实跑命令与结果（原样证据）：
> - `node --test apps/api/test/unit/*.test.cjs` → `ℹ tests 271 / pass 271 / fail 0`
> - `node --test apps/api/test/*.test.cjs` → `ℹ tests 144 / pass 144 / fail 0`
>
> 说明：本次实跑**未执行** `nest build`（`npm test` 会先 build），直接复用工作区既有 `apps/api/dist`。因此实跑结论只对「当前 `dist` ↔ 当前 `src` 一致」这一前提成立；`dist` 与 `src` 是否逐字一致 **未验证**。

---

## 2. 测试代码如何加载生产代码

### 2.1 机制：`require` 编译后的 `dist/*.js`，不是 `src`、不是 `ts-node`

所有测试都是 CommonJS `.cjs`，统一通过相对路径 `require` **编译产物** `apps/api/dist/**/*.js`。证据（每类各举一例）：

| 测试文件 | 引用行 |
| --- | --- |
| `apps/api/test/unit/inventory-service.test.cjs` | `:4` `require("../../dist/platform/inventory/inventory.service.js")` |
| `apps/api/test/unit/payroll-ledger-service.test.cjs` | `:3` `require("../../dist/modules/hr/payroll-ledger.service.js")` |
| `apps/api/test/integration/procurement-inbound.test.cjs` | `:5` `require("../../dist/modules/procurement/raw-material-inbounds.service.js")` |
| `apps/api/test/http/api-exception-filter.test.cjs` | `:3` `require("../../dist/platform/http/api-exception.filter.js")` |
| `apps/api/test/unit/employee-daily-reports-multi-entry.test.cjs` | `:2` `require("../../dist/modules/production/employee-daily-reports.controller.js")` |

**推论**：测试不通过 `ts-node`/`tsx` 加载源码，因此 `dist` 是唯一被测对象。任何人只改 `src` 不 build，测试仍会对旧产物断言。

### 2.2 构建前置是硬依赖

`package.json:10-11`：

```json
"test":      "npm run build --workspace=@dilee/api && node --test apps/api/test/*.test.cjs apps/api/test/unit/**/*.test.cjs",
"test:unit": "npm run build --workspace=@dilee/api && node --test apps/api/test/*.test.cjs apps/api/test/unit/**/*.test.cjs"
```

- `npm test` 与 `npm run test:unit` **完全等价**，都只跑 root + unit，都强制先 `nest build`。
- **`http` 与 `integration` 不在 `npm test` 内**，需通过独立脚本：`package.json:12-15`（`test:api` → `scripts/run-tests.mjs api`；`test:integration` → `scripts/run-tests.mjs integration`）。

### 2.3 三层使用的外部依赖形态完全不同

1. **root / unit 层：手写假 Prisma 对象**。典型形态是内联字面量，例如 `apps/api/test/purchase-orders.test.cjs:7-14`：

   ```js
   const prisma = {
     salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
     bom: { findFirst: async () => ({ id: "bom-1", ... }) },
     ...
   };
   const service = new PurchaseOrdersService(prisma, {});
   ```

   更复杂的形态会伪造 `$transaction`，例如 `apps/api/test/unit/payroll-ledger-service.test.cjs:14`：

   ```js
   prisma.$transaction = async (fn) => fn({ $queryRaw: async () => [], payrollLedger: prisma.payrollLedger, ... });
   ```

   即：**事务是假的**，`$transaction` 只是同步调用回调传一个对象，回滚语义、隔离级别、锁行为全部不存在。

2. **http 层：`fetch` 打已启动的 API**，客户端在 `tests/helpers/api-client.cjs:1-11`，基线地址取自 `process.env.API_BASE_URL`（如 `apps/api/test/http/platform-http.test.cjs:5`）。

3. **integration 层：真 `PrismaClient` + 强制专用测试库**。`tests/helpers/test-context.cjs:8-13`：

   ```js
   function requireTestDatabaseUrl() {
     const url = process.env.TEST_DATABASE_URL;
     if (!url) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL is required; DATABASE_URL is never used by tests");
     if (!/test/i.test(url)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must identify a dedicated test database");
     return url;
   }
   ```

   `scripts/run-tests.mjs:17-20,33` 在缺变量时退出码 3，并把 `DATABASE_URL` 覆写为 `TEST_DATABASE_URL`。

### 2.4 当前环境实测：三层变量全空

```
TEST_DATABASE_URL=[]
API_BASE_URL=[]
PLAYWRIGHT_BASE_URL=[]
```

`.env:10` 只有 `DATABASE_URL=postgresql://dilee:...@127.0.0.1:5432/dilee_erp`（库名不含 `test`，会被 `requireTestDatabaseUrl` 的 `/test/i` 规则拒绝）。全仓库 `.env*` 中**没有任何 `TEST_DATABASE_URL` / `API_BASE_URL` / `PLAYWRIGHT_BASE_URL` 定义**。这与 `docs/test/results/latest-chain-quality-gate.md:9-12` 的四项「环境阻断」一致。

### 2.5 未使用的测试基础设施（重要）

- **`@nestjs/testing` 在 `apps/api/package.json:33` 是 devDependency，但全仓库（`apps/api/test`、`tests`）零引用**。即没有任何测试装配 Nest 模块、控制器、守卫或拦截器。
- `tests/fixtures/test-users.cjs`（8 行，定义 `TEST_ROLE_KEYS`）**未被任何文件引用**（`grep` 于 `tests/` 与 `apps/api/test/` 均无命中）——死夹具。
- `tests/fixtures/business-fixtures.cjs` 只被 `apps/api/test/unit/test-context.test.cjs:4` 引用（即只被「测夹具本身」的测试引用）。
- `tests/helpers/api-client.cjs` 只被 3 个 http 测试引用。
- `tests/helpers/business-invariants.cjs` 被 3 个文件引用，其中 2 个（`unit/business-invariants.test.cjs`、`unit/outsource-logistics-invariants.test.cjs`）是**在测这个 helper 自己**，真正用于链路断言的只有 `integration/procurement-inbound.test.cjs:7`。

---

## 3. 已覆盖清单

覆盖强度评级口径（基于逐文件阅读）：

- **★★★ 强**：多文件/多负面路径 + 状态或幂等断言 + 真实数据库参与
- **★★ 中**：多用例且含负面路径，但全部基于手写假 Prisma，无真实事务
- **★ 弱**：1–3 个用例、仅快乐路径或仅 1 个错误码、无负面路径组合
- **—（间接）**：文件本身未被 `require`，但行为被上层服务的测试间接覆盖

| 模块 | 服务 / 特性 | 测试文件 | 层级 | 断言强度 |
| --- | --- | --- | --- | --- |
| procurement | `raw-material-inbounds.service.ts`（343 行） | `raw-material-inbounds.test.cjs`(4)、`raw-material-inbound-notices.test.cjs`(部分)、`unit/raw-material-inbounds-service.test.cjs`(13)、`unit/raw-material-inbound-post-state.test.cjs`(1)、`unit/raw-material-inbound-batch-trace.test.cjs`(1)、`unit/payable-source-batch-trace.test.cjs`(部分)、`integration/procurement-inbound.test.cjs`(1) | root + unit + **integration** | **★★★ 强**（唯一有真实 DB 过账/冲销/幂等断言的链路，`integration/procurement-inbound.test.cjs:34-65`） |
| procurement | `raw-material-movements.service.ts`（462 行） | `raw-material-issue-operation.test.cjs`(7)、`raw-material-movement-post-lock.test.cjs`(2)、`raw-material-movement-reopen.test.cjs`(5)、`raw-material-movements-risk.test.cjs`(3)、`raw-material-replenishment.test.cjs`(7)、`unit/material-slip-multiplicity.test.cjs`(3)、`integration/raw-material-issues.test.cjs`(1) | root + unit + **integration** | **★★★ 强**（含过账/回退/冲销净额、幂等键、库存不足拦截） |
| procurement | `purchase-orders.service.ts`（184 行） | `purchase-orders.test.cjs`(22)、`unit/purchase-order-batch-sequence.test.cjs`(2) | root + unit | ★★ 中（22 用例覆盖 BOM 来源、状态可编辑性、下游事实拦截，但全为假 Prisma） |
| procurement | `incoming-inspections.service.ts`（116 行） | `incoming-inspections.test.cjs`(14)、`unit/incoming-inspection-batch-sequence.test.cjs`(5) | root + unit | ★★ 中 |
| procurement | `raw-material-inbound-notices.service.ts`（116 行） | `raw-material-inbound-notices.test.cjs`(7) | root | ★★ 中（含幂等、自愈补建草稿） |
| procurement | `procurement-master-data.service.ts`（126 行） | `procurement-master-data.test.cjs`(10)、`master-data-code-mode.test.cjs`(11)、`unit/material-composite-unique.test.cjs`(6) | root + unit | ★★ 中 |
| procurement | `procurement-master-data.controller.ts` / DTO | `procurement-master-data.test.cjs`(部分)、`unit/master-data-create-dto.test.cjs`(部分) | root + unit | ★★ 中（用**真实 `ValidationPipe` 配置**做契约校验，`:12` 复刻 `main.ts:19-28` 的 whitelist/transform/forbidNonWhitelisted） |
| procurement | `purchase-order-export.service.ts`（358 行） | `purchase-order-export.test.cjs`(5) | root | ★ 弱（只测导出表头/列序/小计，无入库数据流） |
| production | `production-orders.service.ts`（329 行） | `unit/production-orders-service.test.cjs`(29)、`production-master-data.test.cjs`(部分)、`integration/production-order.test.cjs`(2) | unit + root + **integration** | ★★★ 强 |
| production | `production-progress.service.ts`（205 行） / `production-progress.domain.ts`（147 行） | `unit/production-progress-service.test.cjs`(4)、`unit/production-progress-domain.test.cjs`(4)、`integration/production-daily-reports.test.cjs`、`integration/production-order.test.cjs` | unit + **integration** | ★★★ 强 |
| production | `employee-daily-reports.service.ts`（356 行） | `unit/employee-daily-reports-multi-entry.test.cjs`(24)、`unit/employee-daily-reports-service.test.cjs`(3)、`integration/production-daily-reports.test.cjs`(1) | unit + **integration** | ★★★ 强（含 Decimal 溢出 422、单位歧义拒绝、历史快照不重算） |
| production | `operation-daily-reports.service.ts`（254 行） | `integration/production-daily-reports.test.cjs` | **integration** | ★ 弱（integration 层易被阻断 ⇒ 本地等于零有效回归） |
| production | `finished-goods-inbound-notices.service.ts`（242 行） | `unit/finished-goods-inbound-notices.test.cjs`(19)、`unit/finished-goods-inbound-chain.test.cjs`(2) | unit | ★★ 中（用例多、含净额与幂等，但无真实 DB） |
| production | `finished-goods-qc.service.ts`（317 行） | `unit/finished-goods-inbound-notices.test.cjs`(部分)、`unit/finished-goods-inbound-chain.test.cjs`(部分) | unit | ★ 弱（317 行服务仅被两个测试文件间接驱动，且无专属测试文件） |
| production | `production-master-data.service.ts`（441 行） | `production-master-data.test.cjs`(8) + `unit/production-orders-service.test.cjs`(部分) | root + unit | ★ 弱（441 行 / 8 用例 / 全假 Prisma） |
| production | `outsource-logistics.service.ts`（**439 行**） | `unit/payable-source-batch-trace.test.cjs`（55 行/4 用例，其中仅 1 个用例涉外加工应付来源标签） | unit | **★ 极弱（见 §4 R2）** |
| production | `material-slip-export.service.ts`（494 行） | `material-slip-export.test.cjs`(9) | root | ★ 弱（仅导出布局与数量口径） |
| production | `production-payroll-export.service.ts`（242 行） | `production-payroll-export-hours.test.cjs`(5)、`unit/material-production-export-layout.test.cjs`(3) | root + unit | ★ 弱（仅小时/分钟口径与表格布局） |
| production | `packaging-operation.ts`（22 行） | `unit/packaging-operation.test.cjs`(3) | unit | ★★ 中（纯函数，覆盖取消态与多道取尾） |
| production | 迁移守卫（DB 约束） | `unit/employee-daily-report-migration-guards.test.cjs`(3)、`unit/material-unique-migration-guard.test.cjs`(4) | unit | ★★ 中（读迁移 SQL 文本做断言，非运行库验证） |
| production | `production-daily-alerts.service.ts`（54 行） | `unit/daily-report-merge-anomalies.test.cjs`(1)、`integration/production-daily-reports.test.cjs` | unit + **integration** | ★ 弱（单用例） |
| sales | `sales-orders.service.ts`（122 行） | `sales-order-chain.test.cjs`(9) | root | ★★ 中 |
| sales | `boms.service.ts`（86 行） | `boms.test.cjs`(9)、`sales-order-chain.test.cjs`(部分) | root | ★★ 中（含并发插入重复错误） |
| sales | `customers.service.ts`（113 行） | `master-data-code-mode.test.cjs`(部分) | root | ★ 弱 |
| sales | `sales-orders.controller.ts` / DTO | `unit/sales-order-dto.test.cjs`(8) | unit | ★★ 中（真实 `ValidationPipe` 契约） |
| sales | `customers.controller.ts` / DTO | `unit/master-data-create-dto.test.cjs`(部分) | unit | ★★ 中 |
| sales | `finished-goods-outbound-notice.service.ts`（213 行） | `unit/outbound-notice-flow.test.cjs`(21) | unit | ★★ 中（21 用例含整批、幂等、CAS 状态条件、应收计价） |
| warehouse | `finished-goods-outbound.service.ts`（304 行） | `unit/finished-goods-outbound-service.test.cjs`(4)、`unit/outbound-notice-flow.test.cjs`(部分) | unit | ★★ 中 |
| warehouse | `finished-goods-inventory.service.ts`（161 行） | `unit/finished-goods-inbound-chain.test.cjs`、`unit/finished-goods-inbound-notices.test.cjs`(部分) | unit | ★ 弱（无专属测试文件） |
| warehouse | `finished-goods-qc.domain.ts`（81 行） | `unit/finished-goods-qc-domain.test.cjs`(5) | unit | ★★ 中（纯函数 + 422 语义） |
| warehouse | `finished-goods-settlement.ts`（62 行） | 无直接引用；行为经 `unit/outbound-notice-flow.test.cjs` 与 `unit/receivable-service.test.cjs` 间接覆盖 | —（间接） | ★ 弱 |
| finance | `receivable.service.ts`（139 行） | `unit/receivable-service.test.cjs`(9) | unit | ★★ 中 |
| finance | `receivable.domain.ts`（23 行） | `unit/receivable-domain.test.cjs`(3) | unit | ★★ 中 |
| finance | `receivable-adjustment.service.ts`（136 行） | `unit/receivable-adjustment-service.test.cjs`(2) | unit | ★ 弱 |
| finance | `receivable-adjustment.domain.ts`（34 行） | `unit/receivable-adjustment-domain.test.cjs`(4) | unit | ★★ 中 |
| finance | `supplier-payable.service.ts`（152 行） | `unit/supplier-payable-service.test.cjs`(7) | unit | ★★ 中 |
| finance | `supplier-payable.domain.ts`（35 行） | `unit/supplier-payable-domain.test.cjs`(3) | unit | ★★ 中 |
| finance | `supplier-payment.service.ts`（103 行） | `unit/supplier-payment-service.test.cjs`(3) | unit | ★ 弱 |
| finance | `customer-payment.service.ts`（69 行） | `unit/customer-payment-service.test.cjs`(2) | unit | ★ 弱 |
| finance | `reconciliation.service.ts`（98 行） | `unit/reconciliation-service.test.cjs`(**1 用例 / 13 行**) | unit | **★ 极弱** |
| finance | `supplier-payable-reconciliation.service.ts`（54 行） | `unit/supplier-payable-reconciliation-service.test.cjs`(**1 用例 / 20 行**) | unit | **★ 极弱** |
| hr | `payroll-ledger.service.ts`（113 行） | `unit/payroll-ledger-service.test.cjs`(13) | unit | ★★ 中 |
| hr | `payroll-payable.service.ts`（143 行） | `unit/payroll-payable-service.test.cjs`(6) | unit | ★★ 中 |
| hr | `salary-payment.service.ts`（38 行） | `unit/salary-payment-service.test.cjs`(5) | unit | ★★ 中 |
| hr | `hr-payroll.domain.ts`（39 行） | `unit/hr-payroll-domain.test.cjs`(6) | unit | ★★ 中 |
| hr | `attendance-performance.service.ts`（27 行） | `hr-attendance.test.cjs`(2)、`unit/attendance-performance-service.test.cjs`(7) | root + unit | ★★ 中 |
| order-workbench | `order-workbench.domain.ts`（51 行） | `unit/order-workbench-domain.test.cjs`(4) | unit | ★★ 中 |
| order-workbench | `order-workbench.service.ts`（103 行） | `unit/finished-goods-workbench-summary.test.cjs`(**2 用例**) | unit | **★ 极弱** |
| alerts | `alerts.domain.ts`（3 行） | `unit/reports-alerts-domain.test.cjs`(2) | unit | ★★ 中（覆盖的是 3 行 domain，`alerts.service.ts` 零覆盖） |
| platform | `inventory.service.ts`（52 行） | `unit/inventory-service.test.cjs`(**1 用例 / 15 行**)、`integration/procurement-inbound.test.cjs:43`、`integration/raw-material-issues.test.cjs` | unit + **integration** | ★ 弱（本地仅 1 个「忽略成品事实」用例） |
| platform | `audit.service.ts`（20 行） | `platform-api.test.cjs`(部分)、`integration/*` | root + **integration** | ★★ 中 |
| platform | `auth.service.ts`（125 行） | `platform-api.test.cjs`（`:5` 登录失败泛化与限流） | root | ★ 弱（125 行服务仅 1 个用例） |
| platform | `daily-sequence-code.ts`（23 行） | `unit/daily-sequence-code.test.cjs`(6) | unit | ★★ 中（纯函数，含 >9999 与手填非数字后缀回归） |
| platform | `api-contract.ts`（28 行） | `platform-api.test.cjs`(2) | root | ★★ 中 |
| platform | `api-exception.filter.ts`（57 行） | `http/api-exception-filter.test.cjs`(2) | http（实为纯单元） | ★★ 中（仅覆盖 P2002 两个分支） |
| platform | `health.controller.ts`（19 行） | `platform-api.test.cjs`(1)、`http/platform-http.test.cjs:7-14` | root + http | ★★ 中 |

---

## 4. 未覆盖 / 弱覆盖清单（按业务风险排序）

### 4.1 风险排序表

| 序 | 风险点 | 未覆盖生产代码（路径 + 行数） | 现状 | 风险说明 |
| ---: | --- | --- | --- | --- |
| R1 | 财务（应收/应付/收付款/调整/对账/关单）**无任何真实数据库证据** | `modules/finance/finance.controller.ts`(112)、`payable-notification.controller.ts`(44) + 7 个 finance service 仅 unit 假 Prisma | 42+2 个端点零 HTTP 测试；7 个服务共 8 个测试文件、深度仅「锁 + 状态重检」 | 唯一真实 DB 的财务断言是 `integration/procurement-inbound.test.cjs:45-65`（已确认应付阻断入库冲销）。核销/超额拦截/退款红字/对账差异全部只在假 Prisma 上验证 |
| R2 | 外加工物流 439 行仅 1 个用例 | `modules/production/outsource-logistics.service.ts`(439)、`outsource-logistics.controller.ts`(50) / 25 个端点 | `unit/payable-source-batch-trace.test.cjs` 55 行、4 用例，其中只有「外加工应付来源同样带出物料名称与单位」触及该服务；`unit/outsource-logistics-invariants.test.cjs`(15 行) 实际只测 `tests/helpers/business-invariants.cjs`，**不 import 该服务** | 派遣/收货/回厂/直发/物料与成品退回/送检共 25 个端点、发料与回厂数量上下界，仅靠 1 个标签用例与 2 个 helper 用例「背书」 |
| R3 | 报表模块整体零覆盖 | `modules/reports/reports.service.ts`(23)、`reports.controller.ts`(11) | **零测试文件引用**（`dist/modules/reports/*` 不在 57 个被引用产物内） | 5 张报表 + CSV 导出 + `EXPORT_LIMIT_EXCEEDED` 5000 行阈值（`reports.service.ts:16`）+ 分页夹紧（`:20` `Math.min(Math.max(page_size ?? 20,1),200)`）全部未验证 |
| R4 | RBAC / 鉴权守卫零覆盖 | `platform/authorization/module-permission.guard.ts`(30)、`authentication.guard.ts`(15)、`module-key.ts`(2)、`require-modules.decorator.ts`(5)、`require-any-modules.decorator.ts`(5)、`require-administrator.decorator.ts`(4) | 零引用；HTTP 层只断言匿名 401 | `module-permission.guard.ts:21-27` 的模块权限集合、`administrator` 短路、`ANY` 语义全部未验证；任务书 `docs/task/0821-03/04-...md:26,39` 明确要求 403/模块隔离测试 |
| R5 | HTTP 契约外壳零覆盖 | `platform/http/response-envelope.interceptor.ts`(18)、`request-id.middleware.ts`(11)、`request-log.middleware.ts`(11)、`api-error.ts`(9)、`empty-string-to-undefined.decorator.ts`(16) | 零引用 | `response-envelope.interceptor.ts:11-15` 决定全站 `{data,meta}` 形状与 `request_id`；本地无测试，只能靠被阻断的 http 层 |
| R6 | 库存服务本地仅 1 个用例 | `platform/inventory/inventory.service.ts`(52)、`inventory.controller.ts`(16) | `unit/inventory-service.test.cjs` 15 行 1 用例；控制器零测试 | 3 个库存端点（`/inventory/balances`、`/raw-material-balances`、`/order-summary`）零 HTTP 测试 |
| R7 | 状态机平台能力零覆盖且疑似死代码 | `platform/state-machine/state-machine.service.ts`(38) | 零测试；仅被 `app.module.ts:10` 与 `state-machine.module.ts:2` 引用，**无任何业务模块 import** | `transition()` 中的 `FOR UPDATE` 行锁 + `stateTransition` 白名单校验（`:21-28`）在生产路径上不可达；同时各业务服务的状态流转各自手写、无统一验证 |
| R8 | 平台通用模块零覆盖 | `platform/forms/forms.service.ts`(44)+`forms.controller.ts`(34)、`platform/attachments/attachments.service.ts`(52)+`attachments.controller.ts`(26)、`platform/dictionaries/dictionaries.service.ts`(35)+`dictionaries.controller.ts`(26)、`platform/authorization/admin-users.controller.ts`(35)、`platform/auth/auth.controller.ts`(24) | 全部零引用 | 附件上传/下载/关联（4 端点）、表单定义与发布（4）、字典类型/条目（8）、管理员用户/角色（4）、auth/me/logout（2）均无测试；宪法第 26-30 条要求字典类目可配置且被引用后须保留快照，无测试佐证 |
| R9 | 财务对账服务极弱 | `modules/finance/reconciliation.service.ts`(98) → 1 用例 13 行；`supplier-payable-reconciliation.service.ts`(54) → 1 用例 20 行 | 各 1 个「resolve 锁 + 状态不可解」用例 | 对账创建、差异计算、`orderClosePreview` 关单阻断（`receivable-adjustment.domain.ts` 已覆盖部分域逻辑）在 service 层无回归 |
| R10 | 工作台成品库存汇总极弱 | `modules/order-workbench/order-workbench.service.ts`(103) → 2 用例 62 行 | 仅覆盖「通知来源过账量扣减」 | 3 个工作台端点零 HTTP 测试 |
| R11 | 生产基础资料 441 行仅 8 用例 | `modules/production/production-master-data.service.ts`(441)、`production-master-data.controller.ts`(90) / 35 个端点 | `production-master-data.test.cjs` 81 行 8 用例 | 部门/岗位/员工/地点/工序/工序费率 35 个端点零 HTTP 测试；员工导入导出（`GET /production/employees/export.xlsx`、`POST /production/employees/import`、`import-template.xlsx`）完全未验证 |
| R12 | 单据导出服务缺乏数据流验证 | `modules/production/material-slip-export.service.ts`(494)、`production-payroll-export.service.ts`(242)、`modules/procurement/purchase-order-export.service.ts`(358) | 只有布局/列序/口径断言（root 层，假 Prisma） | 8 个 `.xlsx` 端点在 HTTP 层零测试；导出限额、空数据、大表分页未验证 |
| R13 | 告警服务零覆盖 | `modules/alerts/alerts.service.ts`(23)、`alerts.controller.ts`(12) | 零引用（只测了 3 行的 `alerts.domain.ts`） | 2 个端点零 HTTP 测试 |
| R14 | 迁移守卫是文本断言而非运行库验证 | `apps/api/test/helpers/migration-guards.cjs`(72 行，3,022 B) 驱动的 3 个迁移守卫测试 | 断言迁移 SQL 文本包含/缺失索引 | 不能证明迁移在实际 PostgreSQL 上真的产出该约束；`docs/task/0821-03/05-...md:25` 要求「空库迁移可重复执行、外键/唯一约束」实测 |
| R15 | 无测试的 wiring / 支撑文件（低风险，但计入 77） | `app.module.ts`(27)、`main.ts`(35)、`build-info.ts`(3)、`platform/config/validate-environment.ts`(9)、`platform/database/prisma.service.ts`(7)、`platform/database/prisma-error.ts`(20)、`platform/logging/structured-logger.ts`(11)、`platform/http/pagination-query.dto.ts`(25)、12 个 `*.module.ts`、其余 controller | 零引用 | `validate-environment.ts`（环境变量校验）、`prisma-error.ts`（P2002 映射，被 master-data/customers 服务 import）具备可测逻辑但无测试 |

### 4.2 零覆盖的模块（整模块无任何测试文件触及）

| 模块 | 代码 | 端点 |
| --- | --- | ---: |
| `modules/reports` | `reports.service.ts`(23) + `reports.controller.ts`(11) | 6 |
| `modules/alerts` | 仅 `alerts.service.ts`(23) + `alerts.controller.ts`(12) 未覆盖（`alerts.domain.ts` 已覆盖） | 2 |
| `platform/forms` | `forms.service.ts`(44) + `forms.controller.ts`(34) | 4 |
| `platform/attachments` | `attachments.service.ts`(52) + `attachments.controller.ts`(26) | 4 |
| `platform/dictionaries` | `dictionaries.service.ts`(35) + `dictionaries.controller.ts`(26) | 8 |
| `platform/state-machine` | `state-machine.service.ts`(38) | 0（无 controller） |

### 4.3 仅单元层、无集成层的服务

以下服务有 unit/root 层测试，但**从未在真实 PostgreSQL 上跑过一次**（`integration/**` 只覆盖 5 个文件，见 §1.3）：

`sales-orders.service.ts`、`boms.service.ts`、`customers.service.ts`、`finished-goods-outbound-notice.service.ts`、`finished-goods-outbound.service.ts`、`finished-goods-inventory.service.ts`、`finished-goods-qc.service.ts`、`finished-goods-inbound-notices.service.ts`、`outsource-logistics.service.ts`、`production-master-data.service.ts`、`production-payroll-export.service.ts`、`material-slip-export.service.ts`、`purchase-orders.service.ts`、`incoming-inspections.service.ts`、`raw-material-inbound-notices.service.ts`、`procurement-master-data.service.ts`、全部 7 个 `finance/*.service.ts`、全部 5 个 `hr/*` 服务、`order-workbench.service.ts`、`inventory.service.ts`（仅在 2 个 integration 文件中作为协作者被间接调用）。

### 4.4 断言密度异常（文件字节数 / 被测服务行数 严重失衡）

| 测试文件 | 测试大小 | 被测服务 | 比值 |
| --- | --- | --- | --- |
| `apps/api/test/unit/inventory-service.test.cjs` | 723 B / 15 行 / 1 用例 | `platform/inventory/inventory.service.ts` 52 行 | 服务 52 行仅被 1 个用例验证 |
| `apps/api/test/unit/reconciliation-service.test.cjs` | 1,032 B / 13 行 / 1 用例 | `modules/finance/reconciliation.service.ts` 98 行 | 1% 级覆盖 |
| `apps/api/test/unit/supplier-payable-reconciliation-service.test.cjs` | 1,072 B / 20 行 / 1 用例 | `modules/finance/supplier-payable-reconciliation.service.ts` 54 行 | 1 个用例 |
| `apps/api/test/unit/raw-material-inbound-batch-trace.test.cjs` | 935 B / 9 行 / 1 用例 | `modules/procurement/raw-material-inbounds.service.ts` 343 行 | 1 个字段映射用例 |
| `apps/api/test/http/production-progress-http.test.cjs` | 770 B / 13 行 / 1 用例 | `production-progress.controller.ts` 28 行（4 端点） | 仅 401 |
| `apps/api/test/unit/receivable-domain.test.cjs` | 848 B / 19 行 | `receivable.domain.ts` 23 行 | 域 3 用例 |
| `apps/api/test/unit/finished-goods-workbench-summary.test.cjs` | 4,655 B / 62 行 / **2 用例** | `order-workbench.service.ts` 103 行 | 2 用例 |
| `apps/api/test/production-master-data.test.cjs` | 6,283 B / 81 行 / 8 用例 | `production-master-data.service.ts` **441 行** + `production-orders.service.ts` 部分 | 55 行服务/用例 |
| `apps/api/test/unit/payable-source-batch-trace.test.cjs` | 3,015 B / 55 行 / 4 用例 | `outsource-logistics.service.ts` **439 行** + `raw-material-inbounds.service.ts` | 外加工 439 行只占 1 个用例 |

> 注：`apps/api/test/unit/*.test.cjs` 中存在大量 700 B – 1.3 KB 的单用例文件（共 10 个文件 ≤ 1.3 KB），它们是「一个错误码一条测试」的形态。

### 4.5 控制器覆盖

37 个 controller 中，**只有 4 个被测试文件以「被测对象」身份 `require`**，且其中 3 个只是为了取 DTO 元数据（`procurement-master-data.controller.ts`、`customers.controller.ts`、`sales-orders.controller.ts`）、1 个为整包字段守卫（`employee-daily-reports.controller.ts`，见 `unit/employee-daily-reports-multi-entry.test.cjs:2`）。**没有任何测试验证 controller 的路由、守卫绑定、参数装饰器或返回包壳**。

---

## 5. 无 HTTP 层测试的端点清单

统计口径：以 `dist` 侧 HTTP 测试实际请求的 19 个方法+路径为「已覆盖」，其余全部列出。**352 − 19 = 333 个端点无 HTTP 层测试**。

已覆盖的 19 个（供对照）：`GET /api/v1/health`（正向）、`POST /api/v1/auth/login`（正向）、`GET /api/v1/sales-orders`（正向，`?page_size=200`），以及仅断言 401 的：`GET /api/v1/customers`、`GET|POST /api/v1/production/material-movements`、`POST /api/v1/production/material-movements/issue-preview`、`POST /api/v1/production/material-movements/returns`、`GET /api/v1/production/material-movements/:id/impact-preview`、`GET|POST /api/v1/production/operation-reports`、`GET|POST /api/v1/production/employee-reports`、`GET /api/v1/production/daily-alerts`、`POST /api/v1/production/daily-alerts/:id/confirm`、`GET /api/v1/production/payroll-sources`、`GET /api/v1/production-progress/measurements`、`GET /api/v1/production-progress/order-statuses`、`GET /api/v1/production-progress/order-statuses/:orderNo/timeline`、`POST /api/v1/production-progress/rebuild`。

### `modules/alerts/alerts.controller.ts`（2）
- GET /api/v1/alerts
- POST /api/v1/alerts/:id/handle

### `modules/finance/finance.controller.ts`（42）
- GET /api/v1/finance/receivable-sources
- GET /api/v1/finance/receivable-sources/:id
- POST /api/v1/finance/receivable-sources/from-outbound/:outboundId
- POST /api/v1/finance/receivable-sources/:id/confirm
- PATCH /api/v1/finance/receivable-sources/:id
- POST /api/v1/finance/receivable-sources/:id/reopen
- POST /api/v1/finance/receivable-sources/:id/cancel
- GET /api/v1/finance/receivable-sources/:id/impact-preview
- GET /api/v1/finance/customer-payments
- GET /api/v1/finance/customer-payments/:id
- POST /api/v1/finance/customer-payments
- PATCH /api/v1/finance/customer-payments/:id
- POST /api/v1/finance/customer-payments/:id/post
- POST /api/v1/finance/customer-payments/:id/reverse
- GET /api/v1/finance/order-summary
- GET /api/v1/finance/receivable-order-summary
- GET /api/v1/finance/receivable-adjustments
- GET /api/v1/finance/receivable-adjustments/:id
- POST /api/v1/finance/receivable-adjustments
- POST /api/v1/finance/receivable-adjustments/:id/post
- POST /api/v1/finance/receivable-adjustments/:id/reverse
- GET /api/v1/finance/reconciliations
- GET /api/v1/finance/reconciliations/:id
- POST /api/v1/finance/reconciliations
- POST /api/v1/finance/reconciliations/:id/resolve
- GET /api/v1/finance/order-close-preview
- GET /api/v1/finance/payable-entries/:id
- POST /api/v1/finance/payable-entries/:id/confirm
- PATCH /api/v1/finance/payable-entries/:id
- POST /api/v1/finance/payable-entries/:id/reopen
- POST /api/v1/finance/payable-entries/:id/reverse
- GET /api/v1/finance/supplier-payments
- GET /api/v1/finance/supplier-payments/:id
- POST /api/v1/finance/supplier-payments
- PATCH /api/v1/finance/supplier-payments/:id
- POST /api/v1/finance/supplier-payments/:id/post
- POST /api/v1/finance/supplier-payments/:id/reverse
- GET /api/v1/finance/payable-order-summary
- GET /api/v1/finance/supplier-payable-reconciliations
- GET /api/v1/finance/supplier-payable-reconciliations/:id
- POST /api/v1/finance/supplier-payable-reconciliations
- POST /api/v1/finance/supplier-payable-reconciliations/:id/resolve

### `modules/finance/payable-notification.controller.ts`（2）
- GET /api/v1/finance/payable-entries
- POST /api/v1/finance/payable-entries/from-source

### `modules/hr/hr.controller.ts`（32）
- GET /api/v1/hr/attendance-records
- POST /api/v1/hr/attendance-records
- PATCH /api/v1/hr/attendance-records/:id
- DELETE /api/v1/hr/attendance-records/:id
- GET /api/v1/hr/performance-records
- POST /api/v1/hr/performance-records
- PATCH /api/v1/hr/performance-records/:id
- DELETE /api/v1/hr/performance-records/:id
- GET /api/v1/hr/payroll-ledgers
- GET /api/v1/hr/payroll-ledgers/:id
- POST /api/v1/hr/payroll-ledgers/generate
- PATCH /api/v1/hr/payroll-ledgers/:id
- DELETE /api/v1/hr/payroll-ledgers/:id
- POST /api/v1/hr/payroll-ledgers/:id/reopen
- POST /api/v1/hr/payroll-ledgers/:id/confirm
- POST /api/v1/hr/payroll-ledgers/:id/close
- GET /api/v1/hr/payroll-ledgers/:id/summary
- GET /api/v1/hr/payroll-payables
- GET /api/v1/hr/payroll-payables/:id
- POST /api/v1/hr/payroll-ledgers/:id/payable
- POST /api/v1/hr/payroll-payables/:id/confirm
- POST /api/v1/hr/payroll-payables/:id/reopen
- POST /api/v1/hr/payroll-payables/:id/reverse
- POST /api/v1/hr/payroll-ledgers/:id/adjustments
- POST /api/v1/hr/payroll-adjustments/:id/post
- POST /api/v1/hr/payroll-adjustments/:id/reverse
- GET /api/v1/hr/salary-payments
- GET /api/v1/hr/salary-payments/:id
- POST /api/v1/hr/salary-payments
- PATCH /api/v1/hr/salary-payments/:id
- POST /api/v1/hr/salary-payments/:id/post
- POST /api/v1/hr/salary-payments/:id/reverse

### `modules/order-workbench/order-workbench.controller.ts`（3）
- GET /api/v1/order-workbench/orders
- GET /api/v1/order-workbench/orders/:order_no
- GET /api/v1/order-workbench/orders/:order_no/timeline

### `modules/procurement/incoming-inspections.controller.ts`（5）
- GET /api/v1/incoming-inspections
- POST /api/v1/incoming-inspections
- PATCH /api/v1/incoming-inspections/:id/status
- POST /api/v1/incoming-inspections/:id/return
- PATCH /api/v1/incoming-inspections/:id

### `modules/procurement/master-data-read.controller.ts`（2）
- GET /api/v1/units
- GET /api/v1/materials

### `modules/procurement/procurement-master-data.controller.ts`（14）
- POST /api/v1/units
- PATCH /api/v1/units/:id
- PATCH /api/v1/units/:id/active
- DELETE /api/v1/units/:id
- POST /api/v1/units/:id/restore
- POST /api/v1/materials
- PATCH /api/v1/materials/:id
- PATCH /api/v1/materials/:id/active
- DELETE /api/v1/materials/:id
- GET /api/v1/suppliers
- POST /api/v1/suppliers
- PATCH /api/v1/suppliers/:id
- PATCH /api/v1/suppliers/:id/active
- DELETE /api/v1/suppliers/:id

### `modules/procurement/purchase-order-export.controller.ts`（2）
- GET /api/v1/procurement/reports/purchase-order.xlsx
- GET /api/v1/procurement/reports/purchase-orders.xlsx

### `modules/procurement/purchase-orders.controller.ts`（13）
- GET /api/v1/purchase-orders
- POST /api/v1/purchase-orders
- PATCH /api/v1/purchase-orders/:id
- GET /api/v1/purchase-orders/:id
- GET /api/v1/purchase-orders/:id/impact-preview
- POST /api/v1/purchase-orders/:id/order
- POST /api/v1/purchase-orders/:id/revert-draft
- POST /api/v1/purchase-orders/:id/cancel
- POST /api/v1/purchase-orders/:id/revert-arrivals
- POST /api/v1/purchase-orders/:id/close-arrivals
- POST /api/v1/purchase-orders/:id/items/:itemId/receipts
- PATCH /api/v1/purchase-orders/receipts/:receiptId
- POST /api/v1/purchase-orders/receipts/:receiptId/cancel

### `modules/procurement/raw-material-inbound-notices.controller.ts`（4）
- GET /api/v1/raw-material-inbound-notices
- GET /api/v1/raw-material-inbound-notices/:id
- POST /api/v1/raw-material-inbound-notices
- PATCH /api/v1/raw-material-inbound-notices/:id/acknowledge

### `modules/procurement/raw-material-inbounds.controller.ts`（8）
- GET /api/v1/raw-material-inbounds
- POST /api/v1/raw-material-inbounds
- PATCH /api/v1/raw-material-inbounds/:id
- DELETE /api/v1/raw-material-inbounds/:id
- POST /api/v1/raw-material-inbounds/:id/post
- GET /api/v1/raw-material-inbounds/:id/impact-preview
- POST /api/v1/raw-material-inbounds/:id/reverse
- GET /api/v1/payable-sources

### `modules/production/employee-daily-reports.controller.ts`（5）
- GET /api/v1/production/employee-reports/:id
- POST /api/v1/production/employee-reports/batch
- PATCH /api/v1/production/employee-reports/:id
- DELETE /api/v1/production/employee-reports/:id
- GET /api/v1/production/employee-reports/:id/impact-preview

### `modules/production/finished-goods-inbound-notices.controller.ts`（7）
- GET /api/v1/production/finished-goods-inbound-notices
- GET /api/v1/production/finished-goods-inbound-notices/:id
- POST /api/v1/production/finished-goods-inbound-notices
- POST /api/v1/production/finished-goods-inbound-notices/:id/cancel
- GET /api/v1/production/orders/:id/finished-goods-summary
- GET /api/v1/finished-goods/inbound-notices
- GET /api/v1/finished-goods/inbound-notices/:id

### `modules/production/finished-goods-qc.controller.ts`（12）
- GET /api/v1/finished-goods/qc/sources
- GET /api/v1/finished-goods/inspection-submissions
- GET /api/v1/finished-goods/inspection-submissions/:id
- POST /api/v1/finished-goods/inspection-submissions
- PATCH /api/v1/finished-goods/inspection-submissions/:id
- POST /api/v1/finished-goods/inspection-submissions/:id/submit
- POST /api/v1/finished-goods/inspection-submissions/:id/cancel
- GET /api/v1/finished-goods/qc-records
- GET /api/v1/finished-goods/qc-records/available-inbound-sources
- GET /api/v1/finished-goods/qc-records/:id/impact-preview
- POST /api/v1/finished-goods/qc-records
- POST /api/v1/finished-goods/qc-records/:id/correct

### `modules/production/material-slip-export.controller.ts`（2）
- GET /api/v1/production/reports/material-issue.xlsx
- GET /api/v1/production/reports/material-slips.xlsx

### `modules/production/operation-daily-reports.controller.ts`（6）
- GET /api/v1/production/operation-reports/:id
- PATCH /api/v1/production/operation-reports/:id
- DELETE /api/v1/production/operation-reports/:id
- GET /api/v1/production/operation-reports/:id/impact-preview
- GET /api/v1/production/orders/:id/progress
- GET /api/v1/production/orders/:id/measurements

### `modules/production/outsource-logistics.controller.ts`（25）
- GET /api/v1/production/outsource-logistics-batches
- GET /api/v1/production/outsource-logistics-batches/payable-sources
- GET /api/v1/production/outsource-logistics-batches/:id/impact-preview
- GET /api/v1/production/outsource-logistics-batches/:id/audit-events
- GET /api/v1/production/outsource-logistics-batches/returns
- GET /api/v1/production/outsource-logistics-batches/direct-shipments
- GET /api/v1/production/outsource-logistics-batches/:id
- POST /api/v1/production/outsource-logistics-batches
- POST /api/v1/production/outsource-logistics-batches/:id/dispatch
- POST /api/v1/production/outsource-logistics-batches/:id/receipts
- POST /api/v1/production/outsource-logistics-batches/receipts/:receiptId/reverse
- POST /api/v1/production/outsource-logistics-batches/:id/cancel-dispatch
- POST /api/v1/production/outsource-logistics-batches/returns/material
- POST /api/v1/production/outsource-logistics-batches/returns/:id/submit-for-qc
- POST /api/v1/production/outsource-logistics-batches/returns/finished-goods
- POST /api/v1/production/outsource-logistics-batches/returns/:id/submit-finished-for-qc
- POST /api/v1/production/outsource-logistics-batches/direct-shipments
- POST /api/v1/production/outsource-logistics-batches/direct-shipments/:id/dispatch
- POST /api/v1/production/outsource-logistics-batches/direct-shipments/:id/reverse
- PATCH /api/v1/production/outsource-logistics-batches/returns/:id
- DELETE /api/v1/production/outsource-logistics-batches/returns/:id
- PATCH /api/v1/production/outsource-logistics-batches/direct-shipments/:id
- DELETE /api/v1/production/outsource-logistics-batches/direct-shipments/:id
- PATCH /api/v1/production/outsource-logistics-batches/:id
- DELETE /api/v1/production/outsource-logistics-batches/:id

### `modules/production/production-daily-alerts.controller.ts`（4）
- GET /api/v1/production/daily-alerts/:id
- GET /api/v1/production/daily-alerts/:id/audit-events
- GET /api/v1/production/daily-report-merge-anomalies
- POST /api/v1/production/daily-report-merge-anomalies/:id/resolve

### `modules/production/production-master-data.controller.ts`（35）
- GET /api/v1/production/departments
- POST /api/v1/production/departments
- PATCH /api/v1/production/departments/:id
- PATCH /api/v1/production/departments/:id/active
- DELETE /api/v1/production/departments/:id
- POST /api/v1/production/departments/:id/restore
- GET /api/v1/production/positions
- POST /api/v1/production/positions
- PATCH /api/v1/production/positions/:id
- PATCH /api/v1/production/positions/:id/active
- DELETE /api/v1/production/positions/:id
- POST /api/v1/production/positions/:id/restore
- GET /api/v1/production/employees/export.xlsx
- GET /api/v1/production/employees/import-template.xlsx
- POST /api/v1/production/employees/import
- GET /api/v1/production/employees
- POST /api/v1/production/employees
- PATCH /api/v1/production/employees/:id
- PATCH /api/v1/production/employees/:id/active
- PATCH /api/v1/production/employees/:id/leave
- GET /api/v1/production/locations
- POST /api/v1/production/locations
- PATCH /api/v1/production/locations/:id
- PATCH /api/v1/production/locations/:id/active
- DELETE /api/v1/production/locations/:id
- POST /api/v1/production/locations/:id/restore
- GET /api/v1/production/operations
- POST /api/v1/production/operations
- PATCH /api/v1/production/operations/:id
- PATCH /api/v1/production/operations/:id/active
- DELETE /api/v1/production/operations/:id
- POST /api/v1/production/operations/:id/restore
- GET /api/v1/production/operation-rates
- POST /api/v1/production/operation-rates
- PATCH /api/v1/production/operation-rates/:id

### `modules/production/production-orders.controller.ts`（13）
- GET /api/v1/production/orders
- GET /api/v1/production/orders/:id
- POST /api/v1/production/orders
- PATCH /api/v1/production/orders/:id
- DELETE /api/v1/production/orders/:id
- POST /api/v1/production/orders/:id/operations
- POST /api/v1/production/orders/:id/operations/batch
- POST /api/v1/production/orders/:id/packaging-operation
- PATCH /api/v1/production/orders/:id/operations/:operationId
- POST /api/v1/production/orders/:id/operations/:operationId/cancel
- POST /api/v1/production/orders/:id/transition
- GET /api/v1/production/orders/:id/impact-preview
- GET /api/v1/production/orders/:id/audit-events

### `modules/production/production-payroll-export.controller.ts`（4）
- GET /api/v1/production/reports/operation-payroll.xlsx
- GET /api/v1/production/reports/order-operation-payroll.xlsx
- GET /api/v1/production/reports/monthly-operations-payroll.xlsx
- GET /api/v1/production/reports/order-material-production.xlsx

### `modules/production/raw-material-movements.controller.ts`（14）
- POST /api/v1/production/material-movements
- POST /api/v1/production/material-movements/scraps
- POST /api/v1/production/material-movements/replenishments
- GET /api/v1/production/material-movements/:id
- PATCH /api/v1/production/material-movements/:id
- DELETE /api/v1/production/material-movements/:id
- GET /api/v1/production/material-movements/:id/reversal-preview
- GET /api/v1/production/material-movements/:id/audit-events
- POST /api/v1/production/material-movements/:id/post
- POST /api/v1/production/material-movements/:id/post-return
- POST /api/v1/production/material-movements/:id/post-replenishment
- POST /api/v1/production/material-movements/:id/post-scrap
- POST /api/v1/production/material-movements/:id/reverse
- POST /api/v1/production/material-movements/:id/reopen

### `modules/reports/reports.controller.ts`（6）
- GET /api/v1/reports/orders
- GET /api/v1/reports/procurement-payables
- GET /api/v1/reports/inventory
- GET /api/v1/reports/production-qc
- GET /api/v1/reports/payroll
- GET /api/v1/reports/:report/export

### `modules/sales/boms.controller.ts`（5）
- GET /api/v1/boms
- GET /api/v1/boms/:id
- POST /api/v1/boms/from-sales-order/:salesOrderId
- PATCH /api/v1/boms/:id
- PUT /api/v1/boms/:id/items

### `modules/sales/customers.controller.ts`（8）
- POST /api/v1/customers
- GET /api/v1/customers/:id
- PATCH /api/v1/customers/:id
- PATCH /api/v1/customers/:id/active
- DELETE /api/v1/customers/:id
- POST /api/v1/customers/:id/contacts
- PATCH /api/v1/customers/:id/contacts/:contactId
- DELETE /api/v1/customers/:id/contacts/:contactId

### `modules/sales/sales-orders.controller.ts`（10）
- POST /api/v1/sales-orders
- GET /api/v1/sales-orders/:id/impact-preview
- GET /api/v1/sales-orders/:id/finished-goods
- POST /api/v1/sales-orders/:id/outbound-notices
- POST /api/v1/sales-orders/:id/outbound-notices/:noticeId/cancel
- GET /api/v1/sales-orders/:id
- PATCH /api/v1/sales-orders/:id
- POST /api/v1/sales-orders/:id/confirm
- POST /api/v1/sales-orders/:id/revert-draft
- POST /api/v1/sales-orders/:id/close

### `modules/warehouse/finished-goods-inventory.controller.ts`（8）
- GET /api/v1/finished-goods/inbounds
- POST /api/v1/finished-goods/inbounds
- POST /api/v1/finished-goods/inbounds/:id/post
- POST /api/v1/finished-goods/inbounds/:id/reverse
- GET /api/v1/finished-goods/defectives
- POST /api/v1/finished-goods/defectives
- POST /api/v1/finished-goods/defectives/:id/post
- POST /api/v1/finished-goods/defectives/:id/reverse

### `modules/warehouse/finished-goods-outbound.controller.ts`（15）
- GET /api/v1/finished-goods/outbound-notices
- POST /api/v1/finished-goods/outbound-notices/:id/create-outbound
- GET /api/v1/finished-goods/outbounds
- GET /api/v1/finished-goods/outbounds/:id
- POST /api/v1/finished-goods/outbounds
- POST /api/v1/finished-goods/outbounds/:id/post
- POST /api/v1/finished-goods/outbounds/:id/cancel
- PATCH /api/v1/finished-goods/outbounds/:id/shipping
- POST /api/v1/finished-goods/outbounds/:id/sign
- POST /api/v1/finished-goods/outbounds/:id/reverse
- GET /api/v1/finished-goods/customer-returns
- GET /api/v1/finished-goods/customer-returns/:id
- POST /api/v1/finished-goods/customer-returns
- POST /api/v1/finished-goods/customer-returns/:id/post
- POST /api/v1/finished-goods/customer-returns/:id/reverse

### `platform/attachments/attachments.controller.ts`（4）
- POST /api/v1/attachments
- POST /api/v1/attachments/:id/links
- GET /api/v1/attachments/:id/download
- DELETE /api/v1/attachments/:id

### `platform/auth/auth.controller.ts`（2）
- GET /api/v1/auth/me
- POST /api/v1/auth/logout

### `platform/authorization/admin-users.controller.ts`（4）
- POST /api/v1/admin/users
- PATCH /api/v1/admin/users/:id/active
- POST /api/v1/admin/users/:id/reset-password
- POST /api/v1/admin/users/:id/roles

### `platform/dictionaries/dictionaries.controller.ts`（8）
- GET /api/v1/dictionaries/types
- POST /api/v1/dictionaries/types
- GET /api/v1/dictionaries/hr/employee-types
- POST /api/v1/dictionaries/hr/employee-types
- GET /api/v1/dictionaries/:typeKey/items
- POST /api/v1/dictionaries/:typeKey/items
- PATCH /api/v1/dictionaries/items/:id
- DELETE /api/v1/dictionaries/items/:id

### `platform/forms/forms.controller.ts`（4）
- GET /api/v1/form-definitions
- GET /api/v1/form-definitions/:id
- POST /api/v1/form-definitions
- POST /api/v1/form-definitions/:id/publish

### `platform/inventory/inventory.controller.ts`（3）
- GET /api/v1/inventory/balances
- GET /api/v1/inventory/raw-material-balances
- GET /api/v1/inventory/order-summary

---

## 6. 重点风险流

### 6.1 状态机（state machine）

**证据**：
- `apps/api/src/platform/state-machine/state-machine.service.ts`（38 行）零测试；`grep` 显示它只被 `apps/api/src/app.module.ts:10` 与 `apps/api/src/platform/state-machine/state-machine.module.ts:2` 引用，**没有任何业务模块 `import` 它**。
- 即 `state-machine.service.ts:19-31` 的 `transition()`（`FOR UPDATE` 行锁 + `stateTransition` 白名单校验 + 非法转换 400）在当前生产代码里**不可达**；同时各业务服务的状态流转各自手写（例如 `raw-material-movements.service.ts`、`production-orders.service.ts`），没有统一回归。
- 各业务状态流转仅以假 Prisma 断言错误码，例如 `apps/api/test/unit/payroll-ledger-service.test.cjs:37-40`（`PAYROLL_PAID_NOT_REOPENABLE`）、`:57-63`（`PAYROLL_NOT_ADJUSTABLE`，同时断言 `lockCount===1` 与 `createCount===0`）。

**缺口**：无可达的统一状态机测试；跨状态「非法动作不得写库」只在假事务上验证。

### 6.2 过账 / 台账 / 财务流

**证据**：
- `apps/api/src/modules/finance/finance.controller.ts:62-111` 有 **42 个端点**，`payable-notification.controller.ts` 2 个，**零 HTTP 测试**（§5）。
- 7 个 finance 服务共 8 个测试文件，全部为假 Prisma；最薄的是 `unit/reconciliation-service.test.cjs`（13 行 / 1 用例）与 `unit/supplier-payable-reconciliation-service.test.cjs`（20 行 / 1 用例）。
- 全仓库唯一对财务事实的真实数据库断言在 `apps/api/test/integration/procurement-inbound.test.cjs:45-65`：手工插入 `supplierPayableEntry`（`:45-61`）后断言 `service.reverse()` 抛 `INBOUND_PAYABLE_ALREADY_CONFIRMED`（`:62-65`）。
- 应收计价口径的纯函数 `apps/api/src/modules/warehouse/finished-goods-settlement.ts`（62 行）**未被任何测试 `require`**；其被 `modules/finance/receivable.service.ts:7` 与 `modules/warehouse/finished-goods-outbound.service.ts:8` 使用。行为只在 `unit/outbound-notice-flow.test.cjs`（如「填写了「应收金额」时，应收按 应收金额 ÷ 订单数量 计价」）与 `unit/receivable-service.test.cjs` 间接覆盖，`receivableAmountFor()`（`:43-50`，整单出库取权威值、部分出库按比例）无直接用例。
- 无真实 DB 证据的财务动作：应收创建/确认/重开/取消、收款创建/过账/核销/冲销、调整过账/冲销、客户与供应商对账创建与 resolve、`orderClosePreview` 关单阻断。

### 6.3 库存流

**证据**：
- `apps/api/src/platform/inventory/inventory.service.ts`（52 行）本地只有 `apps/api/test/unit/inventory-service.test.cjs` **15 行 1 个用例**（`:13-14` 断言成品事实被忽略、`aggregate` 未被调用）。
- 该服务在 `integration/procurement-inbound.test.cjs:43`（`rawMaterialBalance` 期望 "10"）与 `integration/raw-material-issues.test.cjs` 被间接调用，但两个文件均在环境阻断层。
- `apps/api/src/platform/inventory/inventory.controller.ts`（16 行，3 端点）零测试。
- 库存事实的净额口径（过账→回退→再过账后冲销净额 0）只在 `apps/api/test/raw-material-movement-reopen.test.cjs`（「冲销按净额取反」）以假 Prisma 验证。
- 「库存不足必须拦截」在 `apps/api/test/raw-material-movements-risk.test.cjs`（「库存不足仍然必须拦截」）与 `raw-material-replenishment.test.cjs`（「补料过账同样受库存不足拦截，且不写任何库存事实」）以假 Prisma 验证，依赖注入的假 `rawMaterialBalance` 返回值（见 `raw-material-movement-post-lock.test.cjs:54`）。

### 6.4 幂等

**证据**：
- 有幂等用例，但全部假 Prisma：
  - `apps/api/test/raw-material-replenishment.test.cjs`（「同一幂等键重复过账返回同一单据且只写一次库存事实」）
  - `apps/api/test/unit/outbound-notice-flow.test.cjs`（「通知出库支持幂等键：重放精确查回原通知」）
  - `apps/api/test/unit/finished-goods-inbound-notices.test.cjs`（「幂等键重复提交返回同一条通知」）
  - `apps/api/test/raw-material-inbound-notices.test.cjs`（「inbound notice is idempotent for the same inspection」）
  - `apps/api/test/unit/payroll-payable-service.test.cjs`（「payroll payable creation is idempotent for the same ledger」）
- 唯一真实 DB 幂等断言：`integration/procurement-inbound.test.cjs:44` 调用 `assertNoDuplicateSource("payable source idempotency", posted.payableSources)`（helper 定义在 `tests/helpers/business-invariants.cjs:21-24`，仅比较 `raw_material_inbound_id` 集合是否去重）。
- `apps/api/src/platform/database/prisma-error.ts`（20 行，P2002 映射）零测试，而它是幂等冲突/唯一冲突用户可见错误的关键路径。

### 6.5 并发

**证据**：
- 所有「锁」测试只是断言假 Prisma 上的调用计数或 `$executeRaw` 被调用：
  - `apps/api/test/raw-material-movement-post-lock.test.cjs:32-33,62` —— 假 `$queryRaw` 被刻意写成抛 `void` 反序列化错误，断言代码必须走 `$executeRaw`；这是**回归保护**（防 500），不是并发验证。
  - `apps/api/test/unit/payroll-ledger-service.test.cjs:50,61`（`lockCount === 1`）、`unit/supplier-payable-service.test.cjs`、`unit/receivable-service.test.cjs` 等同构。
- `apps/api/test/boms.test.cjs` 有「a concurrent BOM insert has the same duplicate error」，但仍是假 Prisma 返回 P2002，不是两个并行事务。
- 全仓库**没有任何测试并行发起两个写事务**，也没有任何测试断言真实行锁等待、序列化失败重试或死锁处理。
- `apps/api/src/platform/database/daily-sequence-code.ts`（23 行，编号生成）有 6 个纯函数用例（`unit/daily-sequence-code.test.cjs`），但**并发撞号重试**只在 `master-data-code-mode.test.cjs`（「客户：自动编码撞号时重算重试，失败提示只在重试耗尽后出现」）以假 Prisma 验证。

### 6.6 权限 / 审计

**证据**：
- `apps/api/src/platform/authorization/module-permission.guard.ts`（30 行）与 `authentication.guard.ts`（15 行）零测试，而前者被 **34 个 controller 文件** import（`grep` 命中 `finance.controller.ts:6`、`hr.controller.ts:7`、`production-master-data.controller.ts:8` 等）。
- `apps/api/src/platform/http/response-envelope.interceptor.ts`（18 行，决定全站 `{data,meta}` 形状与 `request_id`）零测试。
- 审计断言仅检查「四个审计字段存在」：`tests/helpers/business-invariants.cjs:11-13` 的 `assertAudit` 只遍历 `createdAt/updatedAt/createdBy/updatedBy` 做 `assert.ok`；**不校验 `audit_events` 表**，也不校验服务端是否忽略客户端传入的 `created_by`（`docs/design/testing-system-and-tooling-plan.md:172` 明确要求）。
- `platform/audit/audit.service.ts`（20 行）仅在 `platform-api.test.cjs` 与 2 个 integration 文件被间接引用。

### 6.7 校验契约（DTO）

**证据**：
- 148 个 DTO 类中，只有 3 个 controller 的 DTO 被真实 `ValidationPipe` 校验过：`apps/api/test/unit/master-data-create-dto.test.cjs:12-19`（复刻 `main.ts:19-28` 的 `whitelist+transform+forbidNonWhitelisted`，覆盖 `CustomerDto`/`SupplierDto`/`MaterialDto`）与 `apps/api/test/unit/sales-order-dto.test.cjs`（`SalesOrderDto`/`UpdateSalesOrderDto`）。
- `modules/finance/finance.controller.ts:16-60` 单文件内联 **14 个 DTO 类**，零校验测试。
- 没有任何测试验证 37 个 controller 中其余 34 个的路由/守卫/包壳行为（§4.5）。

### 6.8 失败后无部分写入（事务回滚）

**证据**：
- `integration/procurement-inbound.test.cjs:34` 断言重复过账抛 `INVALID_INBOUND_STATE`，并在 `:35-44` 复查库中只有一条正确事实——这是唯一真实事务语义的负向证据。
- 其余「不写部分数据」断言全部基于假事务，例如 `unit/production-orders-service.test.cjs`（「batch add rechecks duplicates against live operations inside the lock and never writes partial rows」「batch add propagates a row insert failure so the transaction rolls the whole batch back」）——假 `$transaction` 只是 `async (fn) => fn(tx)`，**不会真的回滚**。

---

## 7. 与项目自述测试策略的偏差

对照文档：`docs/design/testing-system-and-tooling-plan.md`（V1.0，2026-08-21）、`docs/test/README.md`、`docs/task/0821-03/01..05`、`docs/task/0821-03/04-http-api-contract-and-authorization-tests.md`。

| # | 文档要求（路径:行） | 现状 | 判定 |
| ---: | --- | --- | --- |
| D1 | §2.2「每个纵向业务切片至少包含一条端到端主路径、关键负向路径、一次回退/冲销路径和一个并发/幂等路径」（`testing-system-and-tooling-plan.md:39`） | integration 层共 **5 文件 / 6 用例**，覆盖 4 条链路（采购入库、生产单、生产日报、原料领料）；sales、finance、HR、warehouse 成品、外加工、reports 全部零 integration；并发路径为零（§6.5） | **严重偏离** |
| D2 | §7 每条链路的「最低证据」含「API + 浏览器主路径 + 来源断言」「真实事务 + 幂等 + order_no 链路」（`:195-202`） | 四项链路门禁在最新记录中全部环境阻断（`docs/test/results/latest-chain-quality-gate.md:9-12`，退出码 3） | **偏离（环境阻断）** |
| D3 | §3.3「`npm run test` # 本地默认快速门禁：unit + build + typecheck」（`:84`） | `package.json:10` 的 `test` = `build` + `node --test apps/api/test/*.test.cjs apps/api/test/unit/**/*.test.cjs`，**不含 typecheck**；typecheck 只在 `scripts/verify-quality.mjs:6`（`verify:quick`）里 | **部分偏离** |
| D4 | §3.3 分层的 `test` 语义（`:79-86`）；三层脚本齐备 | 脚本齐备（`package.json:10-15`），但 `test` 与 `test:unit` **完全等价**，`test` 并不执行 http/integration | **命名与语义部分偏离** |
| D5 | §4 目录规范要求 `apps/web/test/`（`:98`） | `apps/web/test/` 存在但**只有 `.gitkeep`**，零测试文件 | **偏离** |
| D6 | §4 目录规范要求 `docs/test/cases/` 存放「链路用例与人工验收补充」（`:102`） | `docs/test/cases/` 只有 `README.md`（3 行），**零用例文件** | **偏离** |
| D7 | §5.1 固定 5 个测试角色（`sales_operator`/`procurement_operator`/`warehouse_operator`/`finance_operator`/`administrator`）（`:120-126`） | `tests/fixtures/test-users.cjs:1` 定义了这 5 个 key，但该文件**未被任何测试引用**（死夹具）；`docs/test/results/2026-08-22-d5-api-regression.md:8` 记录的集成库为 `dilee_erp_test`，当前环境无 `TEST_DATABASE_URL` | **偏离（夹具存在但未使用）** |
| D8 | §5.2 业务夹具应按依赖顺序提供 `createCustomer()`…`postInbound()` 等工厂（`:134-145`） | `tests/fixtures/business-fixtures.cjs`（13 行）只有 4 个对象构造函数（`customer`/`salesOrder`/`material`/`supplier`），**完全缺失** BOM/采购单/收货/QC/入库/过账工厂；integration 测试改为在用例内直接写 14 行 Prisma 建表语句（`integration/procurement-inbound.test.cjs:18-31`） | **偏离** |
| D9 | §5.3「每个集成测试套件使用独立测试数据库或独立 schema」（`:151`）；§10 测试库与生产库分离 | 设计上满足（`tests/helpers/test-context.cjs:10-11` 拒绝非 test 库名；`scripts/run-tests.mjs:33` 覆写 `DATABASE_URL`）。但 `.env:10` 的 `DATABASE_URL` 指向 `dilee_erp`（不含 test），且没有 `TEST_DATABASE_URL` 定义 | **设计符合 / 执行环境缺失** |
| D10 | §6「建立 `assertBusinessInvariant` 断言库，所有链路复用」，含身份/来源、审计、数量金额、状态回退四类（`:158-187`） | `tests/helpers/business-invariants.cjs`（41 行）实现 6 个断言，但**只覆盖部分**：`assertOrderNo`、`assertQcBalance`、`assertNoDuplicateSource`、`assertInventoryFacts`、`assertAudit`、`assertOutsourceReceiptBalance`、`assertOutsourceNoInventoryEffect`。**缺失**：来源版本/快照一致性、逻辑删除来源不可引用、审计事件表存在性、client `created_by` 覆盖防护、应付/应收金额快照口径、分批核销上限（`:180`）。且真正用于链路的只有 `integration/procurement-inbound.test.cjs:7` 一处 | **部分符合** |
| D11 | §2.4「负向测试必须确认失败后没有部分写入」（`:55`）；§6.4 状态与回退（`:182-187`） | 真实事务下的无部分写入只有 1 处证据（`integration/procurement-inbound.test.cjs:34`）；其余基于假 `$transaction`（§6.8） | **偏离** |
| D12 | §8 首批基线第 3 条「API 门禁：认证、RBAC、统一错误信封、来源版本校验、采购状态动作、分批到货、幂等过账」（`:212`） | HTTP 层只有：健康信封 1 条、匿名 401 共 16 个端点、登录 1 条、销售单分页 1 条。**RBAC 403 / 模块隔离 / 来源版本校验 / 采购状态动作 / 分批到货 / 幂等过账的 HTTP 测试全部缺失** | **严重偏离** |
| D13 | §3.2「覆盖率：第一阶段使用 Node `--experimental-test-coverage` 生成报告」（`:72`） | 全仓库无覆盖率脚本；`package.json` 中无任何 coverage 命令 | **未实施** |
| D14 | §3.2「测试报告：统一输出 JUnit/JSON（供 CI）和人可读 Markdown 摘要」（`:73`）；§9 提交门禁 | `scripts/verify-quality.mjs:15-17` 会写 `docs/test/results/latest-*-quality-gate.md`；但 `.github/workflows/` 下只有 `deploy.yml`，**无 CI 测试工作流** | **部分实施** |
| D15 | §2.1「不测试私有函数的实现细节」/ TDD 技能的实现耦合反模式 | 存在明显实现耦合测试：`apps/api/test/raw-material-movement-post-lock.test.cjs:32,62` 断言「必须用 `$executeRaw` 而不是 `$queryRaw`」；`unit/production-orders-service.test.cjs` 多个用例断言 `lockCount`/`createCount`；`unit/payroll-ledger-service.test.cjs:61-63` 断言 `lockCount===1`、`createCount===0`、`audits.length===0` | **与自述原则存在张力**（这类断言在重构锁实现时会误报） |
| D16 | 任务书 `docs/task/0821-03/04-...md:49-51` 完成记录：「HTTP 测试已覆盖健康信封、匿名 401 和 `request_id`，待测试 API 与 PostgreSQL 可用后执行真实验收」 | 与现状一致；但同一任务书 `:26,39` 要求的 403/模块隔离/来源版本失效/非法状态动作/重复业务编号在测试代码中**不存在** | **自述与范围不符** |
| D17 | 任务书 `docs/task/0821-03/05-...md:25` 要求「验证空库迁移可重复执行、外键/唯一约束、逻辑删除和测试角色初始化」 | `integration/postgres-connectivity.test.cjs`（15 行）只做连接与隔离性检查；迁移约束验证改由**文本断言**完成（`apps/api/test/helpers/migration-guards.cjs` + 3 个迁移守卫测试），未在真实库上执行 | **偏离** |
| D18 | §2.2 测试金字塔「大量：纯函数、契约序列化、校验器测试」（`:36`） | 纯函数测试只有 4 个文件（`daily-sequence-code`、`production-progress-domain`、`finished-goods-qc-domain`、`packaging-operation`）；校验器测试只有 2 个文件（`master-data-create-dto`、`sales-order-dto`）。占比偏服务层假 Prisma（root+unit 共 67 文件中多数为服务层 mock） | **金字塔倒置** |

---

## 8. 未验证事项

以下内容本次**无法验证**，不作结论：

1. `apps/api/dist` 与 `apps/api/src` 是否逐字一致（本次为遵守「不修改任何文件」的要求，未执行 `nest build`）。若 `dist` 过期，§1.3 的实跑通过结论不成立。**未验证**
2. integration 层 6 个用例、http 层 10 个用例在当前代码基线（`c916059`）下是否通过——三层环境变量全空，均为环境阻断。`docs/test/results/2026-08-22-d5-api-regression.md:18-19` 记录 HTTP 6/6、集成 5/5 通过，但那是 2026-08-22 的历史口径，且该文档 `:3` 自述「计时单位已于 2026-09-12 全站改为小时」即规则已变更。**未验证**
3. `apps/api/prisma/schema.prisma` 的模型/索引与 `docs/task/0821-03/05` 的约束要求是否一致（本次未审 schema）。**未验证**
4. `tests/e2e/*.spec.mjs`（4 个 spec）在真实浏览器 + 真实库下的实际行为。**未验证**
5. 各 `.xlsx` 导出服务（4 个 controller、8 个端点）在真实 Excel 解析器下的产物正确性——现有测试只断言服务层返回的行结构。**未验证**
6. `modules/production/finished-goods-qc.service.ts`（317 行）与 `modules/warehouse/finished-goods-inventory.service.ts`（161 行）是否被 `unit/finished-goods-inbound-notices.test.cjs` 完整驱动（本次只统计了引用关系与用例标题，未逐行核对覆盖率）。**未验证**
7. "0 test coverage" 的判定基于 `require('dist/...')` 文本解析；若存在通过动态路径或间接注入被覆盖的文件，本报告会将其列为未覆盖。已对 `finished-goods-settlement.ts`、`daily-report-alerts.ts`、`finished-goods-inbound-notice-status.ts` 做了 import 溯源并标注「间接覆盖」，其余未逐一人工复核。**部分未验证**

---

## 附录 A：被测试直接引用的 57 个生产产物（`dist` 侧）

`health.controller`、`modules/alerts/alerts.domain`、`modules/finance/{customer-payment,receivable,receivable-adjustment,reconciliation,supplier-payable,supplier-payable-reconciliation,supplier-payment}.service`、`modules/finance/{receivable.receivable-adjustment,supplier-payable}.domain`、`modules/hr/{attendance-performance,payroll-ledger,payroll-payable,salary-payment}.service`、`modules/hr/hr-payroll.domain`、`modules/order-workbench/{order-workbench.domain,order-workbench.service}`、`modules/procurement/{incoming-inspections,procurement-master-data,purchase-order-export,purchase-orders,raw-material-inbound-notices,raw-material-inbounds}.service`、`modules/procurement/procurement-master-data.controller`、`modules/production/{employee-daily-reports,finished-goods-inbound-notices,finished-goods-qc,operation-daily-reports,production-daily-alerts,production-master-data,production-orders,production-payroll-export,production-progress,raw-material-movements,outsource-logistics,material-slip-export}.service`、`modules/production/{employee-daily-reports}.controller`、`modules/production/{finished-goods-inbound-notice-status,packaging-operation,production-progress.domain}`、`modules/sales/{boms,customers,sales-orders,finished-goods-outbound-notice}.service`、`modules/sales/{customers,sales-orders}.controller`、`modules/warehouse/{finished-goods-inventory,finished-goods-outbound}.service`、`modules/warehouse/finished-goods-qc.domain`、`platform/{audit,auth,inventory}.service`、`platform/database/daily-sequence-code`、`platform/http/{api-contract,api-exception.filter}`。

## 附录 B：未覆盖的 77 个生产文件（按物理行数降序，仅列业务性文件）

| 行数 | 文件 | 类型 |
| ---: | --- | --- |
| 112 | `src/modules/finance/finance.controller.ts` | controller（42 端点） |
| 90 | `src/modules/production/production-master-data.controller.ts` | controller（35 端点） |
| 66 | `src/modules/hr/hr.controller.ts` | controller（32 端点） |
| 62 | `src/modules/warehouse/finished-goods-settlement.ts` | 纯函数（间接覆盖） |
| 53 | `src/modules/production/material-slip-export.controller.ts` | controller |
| 52 | `src/platform/attachments/attachments.service.ts` | service |
| 51 | `src/modules/procurement/purchase-order-export.controller.ts` | controller |
| 50 | `src/modules/production/outsource-logistics.controller.ts` | controller（25 端点） |
| 47 | `src/modules/production/raw-material-movements.controller.ts` | controller（18 端点） |
| 44 | `src/platform/forms/forms.service.ts` | service |
| 44 | `src/modules/finance/payable-notification.controller.ts` | controller |
| 41 | `src/modules/production/daily-report-alerts.ts` | 纯函数（间接覆盖） |
| 41 | `src/modules/procurement/raw-material-inbound-notices.controller.ts` | controller |
| 39 | `src/modules/sales/boms.controller.ts` | controller |
| 39 | `src/modules/production/finished-goods-inbound-notices.controller.ts` | controller |
| 38 | `src/platform/state-machine/state-machine.service.ts` | service（不可达） |
| 38 | `src/modules/warehouse/finished-goods-outbound.controller.ts` | controller（15 端点） |
| 37 | `src/modules/production/production-orders.controller.ts` | controller（13 端点） |
| 35 | `src/platform/dictionaries/dictionaries.service.ts` | service |
| 35 | `src/platform/authorization/admin-users.controller.ts` | controller |
| 35 | `src/modules/procurement/master-data-read.controller.ts` | controller |
| 35 | `src/modules/procurement/purchase-orders.controller.ts` | controller（13 端点） |
| 35 | `src/main.ts` | 启动装配（管道/过滤器/拦截器绑定） |
| 34 | `src/platform/forms/forms.controller.ts` | controller |
| 33 | `src/modules/production/finished-goods-qc.controller.ts` | controller（12 端点） |
| 33 | `src/modules/production/production.module.ts` | wiring |
| 30 | `src/platform/authorization/module-permission.guard.ts` | guard |
| 28 | `src/modules/production/operation-daily-reports.controller.ts` | controller |
| 28 | `src/modules/production/production-progress.controller.ts` | controller |
| 27 | `src/app.module.ts` | wiring |
| 26 | `src/platform/attachments/attachments.controller.ts` | controller |
| 26 | `src/platform/dictionaries/dictionaries.controller.ts` | controller |
| 25 | `src/platform/http/pagination-query.dto.ts` | DTO |
| 25 | `src/modules/warehouse/finished-goods-inventory.controller.ts` | controller |
| 25 | `src/modules/production/production-payroll-export.controller.ts` | controller（4 端点） |
| 24 | `src/platform/auth/auth.controller.ts` | controller |
| 24 | `src/modules/production/production-daily-alerts.controller.ts` | controller |
| 23 | `src/modules/alerts/alerts.service.ts` | service |
| 23 | `src/modules/reports/reports.service.ts` | service |
| 20 | `src/platform/database/prisma-error.ts` | 纯函数（P2002 映射） |
| 20 | `src/modules/procurement/procurement.module.ts` | wiring |
| 19 | `src/modules/order-workbench/order-workbench.controller.ts` | controller |
| 18 | `src/platform/http/response-envelope.interceptor.ts` | interceptor |
| 16 | `src/platform/inventory/inventory.controller.ts` | controller |
| 16 | `src/platform/http/empty-string-to-undefined.decorator.ts` | decorator |
| 16 | `src/modules/procurement/incoming-inspections.controller.ts` | controller |
| 15 | `src/platform/authorization/authentication.guard.ts` | guard |
| 14 | `src/modules/procurement/raw-material-inbounds.controller.ts` | controller |
| 14 | `src/modules/finance/finance.module.ts` | wiring |
| 12 | `src/modules/alerts/alerts.controller.ts` | controller |
| 11 | `src/modules/reports/reports.controller.ts` | controller |
| 11 | `src/platform/http/request-id.middleware.ts` | middleware |
| 11 | `src/platform/http/request-log.middleware.ts` | middleware |
| 11 | `src/platform/logging/structured-logger.ts` | logger |
| 11 | `src/modules/sales/sales.module.ts` | wiring |
| 10 | `src/modules/hr/hr.module.ts` | wiring |
| 9 | `src/platform/http/api-error.ts` | 纯函数 |
| 9 | `src/platform/config/validate-environment.ts` | 纯函数 |
| 9 | `src/platform/authorization/authorization.module.ts` | wiring |
| 8 | `src/platform/attachments/attachments.module.ts` | wiring |
| 8 | `src/platform/auth/auth.module.ts` | wiring |
| 8 | `src/platform/dictionaries/dictionaries.module.ts` | wiring |
| 7 | `src/platform/database/prisma.service.ts` | wiring |
| 7 | `src/platform/forms/forms.module.ts` | wiring |
| 7 | `src/platform/inventory/inventory.module.ts` | wiring |
| 6 | `src/platform/state-machine/state-machine.module.ts` | wiring |
| 6 | `src/platform/database/database.module.ts` | wiring |
| 6 | `src/platform/audit/current-user.decorator.ts` | decorator |
| 6 | `src/modules/order-workbench/order-workbench.module.ts` | wiring |
| 5 | `src/platform/authorization/require-any-modules.decorator.ts` | decorator |
| 5 | `src/platform/authorization/require-modules.decorator.ts` | decorator |
| 5 | `src/modules/alerts/alerts.module.ts` | wiring |
| 5 | `src/platform/audit/audit.module.ts` | wiring |
| 4 | `src/platform/authorization/require-administrator.decorator.ts` | decorator |
| 4 | `src/modules/reports/reports.module.ts` | wiring |
| 3 | `src/build-info.ts` | 常量 |
| 2 | `src/platform/authorization/module-key.ts` | 类型/常量 |
