# 测试环境 Runbook

- 目的：把"链路三层永远 `TEST_BLOCKED`"变成一条命令可复现的本地/CI 环境。
- 对应规划：`docs/test/01-test-master-plan.md` §2.2 **S8 环境解阻**。
- 适用：本地开发机（Windows）、CI（ubuntu-latest）。

---

## 1. 一句话上手

```powershell
docker desktop 已启动的前提下：
powershell -ExecutionPolicy Bypass -File scripts/dev-test-up.ps1 -Workers 4
. $env:TEMP\dilee-test-env.ps1
npm run test:integration      # 真实 PostgreSQL
npm run test:api              # 需要 API 在跑
npm run test:e2e              # 需要 API + Web 在跑
```

`dev-test-up.ps1` 做四件事：起 PostgreSQL → 建测试库并迁移 → 灌管理员与字典 → 导出环境变量文件。

---

## 2. 前置条件

| # | 条件 | 校验方式 |
| --- | --- | --- |
| 1 | Docker Desktop 已安装且**守护进程在运行** | `docker info --format '{{.ServerVersion}}'` |
| 2 | Node v22+（本机实测 v24.15，原生类型擦除可直接跑 `.ts`） | `node --version` |
| 3 | 根依赖已安装 | `npm ci` |
| 4 | Prisma Client 已生成 | `npx prisma generate --schema apps/api/prisma/schema.prisma` |
| 5 | API 产物是最新的（集成测试 `require` 编译后的 `dist/`） | `npm run build --workspace=@dilee/api` |

> ⚠️ **集成测试加载的是 `apps/api/dist/**`，不是 `src/**`。** 改了 `src` 必须先 build，否则测试跑的是旧代码。

---

## 3. 测试库与隔离模型

```
postgres:16-alpine 容器（docker compose service: postgres）
└── dilee_test          ← 模板库：迁移 63 条 + 管理员与字典种子
    ├── dilee_test_01   ← worker 1（从模板 CREATE DATABASE ... TEMPLATE 克隆，秒级）
    ├── dilee_test_02   ← worker 2
    └── ...
```

**为什么要 worker 库**：集成测试与 E2E 都写入真实库，共用一库时唯一约束、`order_no` 前缀与清理顺序互相干扰，只能串行。实测（`01-test-master-plan.md` §6.3）：不隔离时并行天花板锁死在 **27.6 小时**，且 Agent 从 4 加到 16 **收益严格为零**；隔离后 8 Agent 可降到 **20.5 小时**。

| 脚本 | 作用 |
| --- | --- |
| `npm run db:test:provision` | 建模板库 + 迁移 + 克隆 worker 库（默认 8 个） |
| `npm run db:test:provision -- --reset` | 先删后建（schema / migration 变更后必须用） |
| `npm run db:test:provision -- --workers 4` | 指定 worker 数量 |
| `npm run db:test:prepare` | 只对 `TEST_DATABASE_URL` 跑 `migrate deploy`（既有脚本，CI 单库场景用） |

**库名必须含 `test`** —— `tests/helpers/test-context.cjs:11` 与 `scripts/prepare-test-database.mjs:4` 强制校验，机制上防止误连生产库。

### worker 寻址契约

`tests/helpers/test-databases.cjs` 按索引取独占库：

```
testDatabaseUrlFor(1)  →  $env:TEST_DATABASE_URL_1  （若已注入）
                        →  否则由 TEST_DATABASE_URL 推导 <dbname>_01
                        →  否则回退 TEST_DATABASE_URL 本身（串行，行为与改造前一致）
```

---

## 4. 环境变量

| 变量 | 用途 | 缺失时 |
| --- | --- | --- |
| `TEST_DATABASE_URL` | 集成测试与 E2E 的库（模板库） | `test:integration` → `exit 3` |
| `TEST_DATABASE_URL_<N>` | 并行 worker 库 | 可选；缺省回退单库 |
| `API_BASE_URL` | HTTP 契约测试目标 | `test:api` → `exit 3` |
| `PLAYWRIGHT_BASE_URL` | E2E 浏览器目标 | `test:e2e` → `exit 3` |
| `API_INTERNAL_URL` | Next.js `/api/v1` 反向代理目标（默认 `http://localhost:3001`） | 默认值可用 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | 种子管理员 + HTTP 测试登录 | HTTP 测试抛 `TEST_BLOCKED` |
| `COOKIE_SECURE` | 本地 http 必须 `false`，否则 Cookie 不下发 | 默认按 `NODE_ENV` 推断 |

### 环境阻断语义（不要改）

`scripts/run-tests.mjs:17-30` 在缺变量时输出 `TEST_BLOCKED: ...` 并 **`exit 3`**。
`scripts/verify-quality.mjs` 把它如实记录为"环境阻断"而非"通过"。
这是本项目最好的测试设计之一（决策见 `docs/design/testing-system-and-tooling-plan.md:242`），**新增门禁必须沿用，不得降级为成功**。

---

## 5. 三层测试怎么跑

### 5.1 快速层（无需数据库）

```powershell
npm run test            # typecheck + test:unit
npm run test:unit       # 后端 415 + 前端 lib 108 + 前端组件 12
npm run test:unit:api   # 仅后端（含 api build）
npm run test:unit:web   # 仅前端（lib + 组件）
npm run test:coverage   # 后端 --experimental-test-coverage + 前端 vitest --coverage
```

实测：后端 415 例 **5.3s**（不含 build）/ 22.5s（含 build）；前端 lib 108 例 **0.5s**；前端组件 12 例 **3.6s**。

### 5.2 链路层（需要数据库）

```powershell
# 1) 环境
powershell -ExecutionPolicy Bypass -File scripts/dev-test-up.ps1 -Workers 4
. $env:TEMP\dilee-test-env.ps1

# 2) 集成（真实 Prisma + 事务）
npm run test:integration

# 3) HTTP 契约（需要 API 在跑）
$env:DATABASE_URL = $env:TEST_DATABASE_URL
node apps/api/dist/main.js        # 另开一个终端
npm run test:api

# 4) E2E（需要 API + Web 在跑）
npm run build --workspace=@dilee/web
npm run test:e2e
```

> **`test:api` 需要同时注入 `API_BASE_URL` 与 `TEST_DATABASE_URL`。**
> 前者是请求目标；后者给「种子角色用户」用 —— 鉴权矩阵契约测试
> （`authorization-matrix-contract.test.cjs`）必须造出各模块角色用户才能断言 403，
> 而种子是写进**运行中 API 所连的那个库**的。
> 只设 `API_BASE_URL` 时该文件会在**模块加载期**抛出一条明确的 `TEST_BLOCKED`
> （而不是几十条看不懂的失败）。CI 的 chain job 两个变量都设了，不受影响。
>
> E2E 还要注意：**每次 `next build` 之后必须把 `.next/static` 复制进 standalone 目录**，
> 否则页面会引用 404 的静态资源、表现为全部 E2E 失败（见 §6 故障排查表）。


E2E 的 Web 服务由 `playwright.config.mjs` 的 `webServer` 自动拉起（`reuseExistingServer: true`，已在跑的会被复用）。

---

## 6. 故障排查（本次实测踩到的坑）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `failed to connect to the docker API at npipe://.../dockerDesktopLinuxEngine` | Docker Desktop 守护进程未运行 | 启动 Docker Desktop，等 `docker info` 返回 ServerVersion |
| **`/api/v1/health` 返回 503「数据库不可用」，且集成测试挂起至超时** | **Docker Desktop 自行退出**导致 PostgreSQL 不可达（5432 无监听） | 重启 Docker Desktop → `docker compose up -d postgres` → **先探一次 5432 再跑链路门禁**。否则会把"数据库没起来"误读成测试失败（实测踩过一次：E2E 首跑 3/5，DB 恢复并经健康检查稳定后连跑 3 次 5/5） |
| `next build` 报 `FATAL ERROR: Zone Allocation failed - process out of memory`（堆仅 9-30 MB，物理内存充足） | **`.next` 缓存损坏**，不是真的内存不足 | 删掉 `apps/web/.next` 重建。本次清缓存后同一命令一次通过（22 条路由） |
| `.ps1` 脚本报 `Unexpected token` / `Missing closing ')'`，且脚本内含中文 | **PowerShell 5.1 把无 BOM 的 UTF-8 当系统 ANSI 读取**，中文注释被拆成非法字节 | 脚本存为 **UTF-8 with BOM**。本仓库无 `pwsh`（PowerShell 7），只有 `powershell` 5.1 |
| Prisma 命令输出被 PowerShell 当成错误（`NativeCommandError`） | Prisma 把进度写到 **stderr**，PS 将 stderr 视为错误记录 | 忽略即可；判断成败看 `$LASTEXITCODE`，不要看有无红色输出 |
| `source database is being accessed by other users` | `CREATE DATABASE ... TEMPLATE` 要求模板库无活动连接 | provision 脚本已内置 `pg_terminate_backend`；手工操作时先断开 |
| 集成测试失败但代码没改 | `dist/` 落后于 `src/` | `npm run build --workspace=@dilee/api` |
| E2E 报 `TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required` | 环境变量未注入 | `. $env:TEMP\dilee-test-env.ps1` |
| Linux CI 上 Web 起不来 | `playwright.config.mjs` 原先硬编码 Windows 的 `xcopy` | 已按 `process.platform` 分支（`xcopy` / `cp -r`） |
| **全部 E2E 用例突然失败（连未改动的认证用例也失败）** | **`next build` 会清掉 `apps/web/.next/standalone/apps/web/.next/static`**。手工启动 standalone server 而不复制静态资源时，页面 HTML 引用 404 的 CSS/JS，表现为 URL 断言失败 / `element(s) not found` | `npm run build` 之后必须复制：<br>`New-Item -ItemType Directory -Force apps/web/.next/standalone/apps/web/.next`<br>`Copy-Item -Recurse -Force apps/web/.next/static apps/web/.next/standalone/apps/web/.next/`<br>（Playwright 的 `webServer` 命令自带这一步；手工启动才需要自己做。**这是环境问题，不是产品回归**） |
| 组件测试报 `TypeError: target.hasPointerCapture is not a function` | jsdom 未实现 Pointer Events 捕获 API，而 Radix Select 依赖它 | 已在 `apps/web/test/setup.ts` 补最小桩（含 `scrollIntoView` 与 `ResizeObserver`） |

---

## 7. 当前已知问题

### 7.1 四级门禁现状：全部转绿（2026-09-13）

| 层 | 用例 | 结果 |
| --- | ---: | --- |
| 单元（后端 474 / 前端 lib 108 / 前端组件 25） | 607 | ✅ |
| 集成（真实 PostgreSQL） | 9 | ✅ |
| HTTP 契约（真实 API） | 355（1 skip） | ✅（连跑多次稳定） |
| E2E（浏览器 + Web + API + DB） | 5 | ✅（13 秒） |

> 此前 E2E 长期 2/5，原因被项目自述误判为"选择器不稳定"，实为**目标 UI 已被迁移重写**。3 条 spec 已按当前 UI 重写，详见 `docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md`。

### 7.2 已知契约缺陷护栏（W2 已固化）

`apps/api/test/http/contract-guardrails.test.cjs` 以 `KNOWN_CONTRACT_DEFECT` 前缀固化了 5 个缺陷（D2 `meta.request_id`、D7 报表 `meta.total` 语义、D8 `sort` 未实现、D9 未知 query 参数行为分裂、D10 嵌套校验丢失 details）；单元层另有 U2（P2025/P2003 落 500）与三个审计缺口的护栏。这些用例**当前通过**，一旦缺陷被修复就会变红 —— 那是修复信号，请同步更新对应文件与 recon 记录。

### 7.3 E2E 新发现的产品问题（**均已修复**，2026-09-13）

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | `searchable-select` 在 `ActionDialog` 内弹层被裁切：触发点靠近对话框顶部时朝上的弹层落到裁切盒之外，顶部选项鼠标点不到 | ✅ **已修**：抽出纯函数 `choosePopoverPlacement`，两侧都放不下时选空间更大一侧并把高度收敛到该侧可用空间内；8 条测试护栏 |
| 2 | 告警中心「确认」只写 `alert_handling`，未联动 `/production/daily-alerts/:id/confirm`，确认后订单侧阻塞仍在 | ✅ **已修**：`handleAlert` 对 `production_daily_alert` 追加 confirm 调用（定向容忍已恢复告警）；4 条组件护栏 + 1 条 E2E 断言 |
| 3 | 主数据未加载完成时即可打开对话框，得到**永久为空**的选项列表 | ✅ **已修**：受影响的两个入口加 `disabled={loading}`（其余页面因 loading 时提前 return 而不受影响）；3 条组件护栏 |

详见 `docs/test/results/2026-09-13-three-product-fixes.md`。

### 7.4 审计可追溯性缺口（W1 新发现，建议单独立项）

| # | 缺口 | 证据 |
| --- | --- | --- |
| 1 | `AuditService.record()` **从不写 `orderNo` 列**（只把 `order_no` 放进 `details`），导致审计事件无法按订单检索 | `platform/audit/audit.service.ts:15` vs `:18`；单元护栏 `unit/audit-and-request-id.test.cjs` |
| 2 | 接收通知时补建的草稿入库单**没有 `create` 审计事件** | `raw-material-inbound-notices.service.ts:92` 走事务内 `createDraftForInspection`，而该审计只在 `raw-material-inbounds.service.ts:125` 写 |
| 3 | 通知接收的审计事件**完全没有订单引用**（只传 `{ status }`） | `raw-material-inbound-notices.service.ts:103` |

**对写测试的影响**：清理审计事件时只按 `orderNo` 列删会漏掉绝大多数行，`audit_events` 会持续堆积。夹具的 `fx.auditScope()` 已同时覆盖 `orderNo` 列、`details.order_no` 与 `entityId` 三种关联方式；实测连续两次运行计数零增长。

### 7.5 写 HTTP 契约测试必读的两条环境约束

**① 本 API 是「单会话」的 —— 同一用户名不能并发登录。**
`AuthService.login()` 会先 `session.deleteMany({ where: { userId } })` 再建新会话（`auth.service.ts:29`），
即**第二次登录会踢掉第一次的 Cookie**。
`node --test` 默认**并行执行多个文件**，因此多个契约测试文件同时以 admin 登录时，
会互相作废对方的会话，表现为**随机 401**（症状：`期望状态码 200，实际 401 UNAUTHENTICATED`）。

处理：`test:api:raw` 已加 `--test-concurrency=1` 串行执行（该层总耗时约 1 秒，串行代价可忽略）。
若你手工跑多文件契约测试，请务必带上该参数：

```powershell
node --test --test-concurrency=1 apps/api/test/http/**/*.test.cjs
```

需要真正并行时，改为**每个文件用不同的用户**（见 `tests/fixtures/seed-users.cjs` 的 `seedTestUsers`）。

**② `/api/v1/health` 在数据库竞争下会返回 503。**
`health.controller.ts:16` 在 DB 探测失败时返回 503 `DEPENDENCY_UNAVAILABLE`。
写契约测试时**不要对 `/health` 硬断言 200**；应接受两种合法结果并各自校验信封形状
（`contract-guardrails.test.cjs` 即如此）。



---

## 8. CI

| Workflow | 触发 | 内容 |
| --- | --- | --- |
| `.github/workflows/test.yml` → `fast` | push main / PR / 手动 | `typecheck` → `test:unit` → api build → web build（**无需数据库**） |
| `.github/workflows/test.yml` → `chain` | 同上（依赖 `fast`） | postgres service → 迁移 → 种子 → 起 API → 起 Web → integration → api → e2e |
| `.github/workflows/deploy.yml` → `verify` | push main / 手动 | `typecheck` → **`test:unit`（本次新增）** → api build → web build |

CI 中 `chain` 在集成 4 条陈旧用例修好前会失败 —— 这是**有意为之**：按项目既定原则，失败不得被吞掉或降级（`testing-system-and-tooling-plan.md:242`）。

---

*本文档基于 2026-09-13 的实跑验证编写。所有命令与现象均在 Windows 11 + PowerShell 5.1 + Docker 29.7.2 + Node v24.15 上实测。*
