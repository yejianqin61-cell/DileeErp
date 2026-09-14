# 迪礼 ERP 测试总览排期规划

- 文档类型：测试工程总览、排期与多 Agent 并行成本预测
- 编制角色：测试总工程师
- 审计基线：`c916059`（工作区未提交状态）
- 编制日期：2026-09-12
- 上游依据：`docs/design/testing-system-and-tooling-plan.md`、`docs/design/global-api-contract.md`、`.agent/constitution/constitution.md`
- 配套勘察报告：
  - `docs/test/00-recon-backend-coverage.md`（后端覆盖缺口，904 行）
  - `docs/test/00-recon-frontend-coverage.md`（前端覆盖缺口，546 行）
  - `docs/test/00-recon-api-contract.md`（API 契约与错误语义，679 行）
- 执行记录：
  - `docs/test/02-test-environment-runbook.md`（环境 Runbook，故障排查）
  - `docs/test/results/2026-09-13-w0-environment-unblock.md`（**W0 已完成**：环境解阻 + 地基建）
  - `docs/test/results/2026-09-13-w1-fixtures-and-harness.md`（**W1 已完成**：夹具 / 测试用户 / 契约 harness / 不变量）
  - `docs/test/results/2026-09-13-w2-testids-guardrails-and-stale-fixes.md`（**W2 已完成** + 4 条陈旧集成用例修复）
  - `docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md`（**E2E 重写 + 平台层单元扩张**，四级门禁全绿）
  - `docs/test/results/2026-09-13-three-product-fixes.md`（**三个产品缺陷修复** 3→2→1）
  - `docs/test/results/2026-09-13-w3-backend-unit-wave1.md`（**W3 第一波**：后端单元 +370 用例，含 11 项新缺陷清单）
  - `docs/test/results/2026-09-13-w4-http-contract-wave1.md`（**W4 第一波**：HTTP 契约 +336 用例，含 D11/D12 缺陷）
  - `docs/test/results/2026-09-13-w5-frontend-behavior-wave1.md`（**W5 第一波**：前端行为测试 +228 用例，含表格枚举未中文化的系统性发现）
  - `docs/test/results/2026-09-13-w5-frontend-behavior-wave2.md`（**W5 第二波**：前端 +142 用例、遗留正则测试逐文件裁定、CI 阻塞修复）

---

## 0. 结论摘要

### 0.0 执行状态（2026-09-13 更新）

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 勘察 + 规划 | ✅ 已完成 | 本文档 + 3 份 recon 报告 |
| **W0 环境解阻 + 测试地基建** | ✅ **已完成** | `docs/test/results/2026-09-13-w0-environment-unblock.md` |
| **W1 地基 B（夹具/测试用户/契约 harness/不变量）** | ✅ **已完成** | `docs/test/results/2026-09-13-w1-fixtures-and-harness.md` |
| **陈旧集成用例修复（4 条）** | ✅ **已完成** | 集成层 5/9 → **9/9**；见 W2 执行记录 §3 |
| **W2 `data-testid` + 契约护栏 + 路由差集** | ✅ **已完成** | `docs/test/results/2026-09-13-w2-testids-guardrails-and-stale-fixes.md` |
| **E2E 重写 + 平台层单元扩张** | ✅ **已完成** | `docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md` |
| **三个产品缺陷修复（3→2→1）** | ✅ **已完成** | `docs/test/results/2026-09-13-three-product-fixes.md` |
| **W3 第一波：后端单元 ×12 模块** | ✅ **已完成**（+370 用例 → 后端 844） | `docs/test/results/2026-09-13-w3-backend-unit-wave1.md` |
| **W4 第一波：HTTP 契约 ×9 文件** | ✅ **已完成**（+336 用例 → 契约 355） | `docs/test/results/2026-09-13-w4-http-contract-wave1.md` |
| **W5 第一波：前端行为测试 ×9 文件** | ✅ **已完成**（+228 用例 → 前端组件 268） | `docs/test/results/2026-09-13-w5-frontend-behavior-wave1.md` |
| **W5 第二波：前端行为测试 ×6 文件 + 遗留正则测试裁定** | ✅ **已完成**（+142 用例 → 前端组件 410；修复一处 CI 阻塞） | `docs/test/results/2026-09-13-w5-frontend-behavior-wave2.md` |
| W3 第二波（其余后端单元） | ⬜ 待启动 | §5.1 |
| W4 第二波（其余控制器 + 导出/IDOR 专项） | ⬜ 待启动 | §5.1 |
| W5 第三波（16 个无组件级测试的路由页）+ 收尾 | ⬜ 待启动 | §5.1 |
| W6–W8（集成并发 / E2E 扩展 / 收敛） | ⬜ 待启动 | §5.1 |

## 0.0.1 四级门禁现状（2026-09-13）

| 层 | 用例 | 结果 |
| --- | ---: | --- |
| 类型检查 | — | ✅ exit 0 |
| 单元 | **1,362**（后端 **844** + 前端 lib 108 + 前端组件 **410**） | ✅ 0 失败 |
| 集成（真实 PostgreSQL） | **9** | ✅ 全绿 |
| HTTP 契约（真实 API） | **355**（1 skip） | ✅ 0 失败，连跑稳定 |
| E2E（浏览器 + Web + API + DB） | **5** | ✅ 全绿，连跑 3 次稳定（12 秒） |

> 后端单元 415 → **844**；HTTP 契约 19 → **355**；前端组件 12 → **410**；自动化用例总数 532 → **1,734**。

**关键排障（W4）**：困扰多轮的「随机 401」根因是 **API 单会话语义 + `node --test` 默认并行多文件**
（`auth.service.ts:29` 登录先删该用户全部 session），**不是代码缺陷**。
已通过 `test:api:raw` 加 `--test-concurrency=1` 解决，并写入 Runbook §7.5。

**CI 阻塞修复（W5 第二波）**：全量前端套件在 16 核机器上会 `FATAL ERROR: Zone Allocation failed`（exit 134）——
Vitest 默认按 CPU 数开 worker，22 个 jsdom+Radix 文件同时跑会打爆内存。
已在 `apps/web/vitest.config.mts` 设 `maxWorkers: 4`（实测全绿、27s）；CI 的 2 核机器本就不触及该上限。

**W5 的系统性发现**：`DataTable` 的 `displayText` 桥接（`data-table.tsx:14`）对**表体单元格永不生效** ——
TanStack 为无自定义 `cell` 的列注入了默认 `cell` 函数（`table-core/build/lib/index.mjs:2872`），
`flexRender` 因此总返回 React 元素而非字符串，`typeof value === "string"` 判定为假。
**后果：全站表格里的枚举值都以英文原值呈现**（工作台 `confirmed`/`recorded`、工序状态 `active` 等）。

详见 W5 执行记录 §3。





**W0 关键成果**：链路三层从长期 `exit 3 TEST_BLOCKED` 变为**可执行**；新增 12 条前端组件用例；`npm run test:unit` 一条命令跑通；后端覆盖率基线 **77.29% 行**。

**W1 关键成果**：夹具工厂实现**零残留**清理（21 张表计数快照逐字节一致，含最易漏的 `audit_events`）；测试用户覆盖 8 种角色；契约 harness 修掉"Bearer 头后端不认"的静默失效；不变量断言 6 → **25 个**。

**W2 关键成果**：4 条陈旧集成用例全部修复（集成层 **9/9 全绿**）；S11 实测前后端路由**零不一致**；S12 把 D2/D7/D8/D9/D10 五个契约缺陷固化为"修复即变红"的护栏（HTTP 契约 10 → **19**）；S6 铺设 30 个文件的 testid 钩子 + 13 条渲染级组件测试。

**关键发现（W2）**：3 条 E2E spec 写在**已被迁移重写的 UI** 上（`保存工序日报`/`新增生产地点` 等字符串在 `apps/web` 零命中），因此**加 testid 不可能让它们变绿**，必须按当前 UI 重写 —— 这推翻了项目自述里"只是选择器问题"的定性。

**E2E 重写 + 平台层扩张（最新）**：3 条 spec 已按当前 UI 重写并全部通过，**四级门禁首次全线转绿**；同时补齐 recon 点名的平台层空白（权限守卫、认证守卫、响应信封拦截器、错误信封映射、审计与请求 id）共 **+39 条**单元测试，并修复了一处自造的 flaky 测试。前端确认零功能变更（仅惰性 `data-testid`）。



### 0.1 一句话结论

本项目的测试体系**方向正确、骨架已立、但中间层几乎为空，且未接入 CI**。真正缺的不是"更多单元测试"，而是**接口/契约层、集成层、前端交互层这三块地基**，以及让它们能并行跑起来的**测试数据隔离能力**。前端所谓"108 个用例全绿"中，12/19 个文件是读 `.tsx` 源码做正则断言，不渲染、不点击——这是假安全。

### 0.2 五个关键判断

| # | 判断 | 依据 |
| --- | --- | --- |
| J1 | **必须补全脚手架，但应"精准补全"而非重建**。后端 `node:test` + `dist` 加载方案实测 415 用例 8 秒跑完，性能优秀，应保留；需要新增的是前端组件测试工具链、测试 DB 隔离、夹具工厂、CI 接线。 | §2 |
| J2 | **测试金字塔在"腰部"断裂**：单元 415 例、集成 6 例、HTTP 契约 10 例、E2E 5 例。单元层已达标，中间三层形同占位。 | §1.2 |
| J3 | **CI 完全不跑测试**。全仓库唯一 workflow `.github/workflows/deploy.yml` 只做 `typecheck` + 两个 `build`，且只在 push main 触发，PR 不触发。 | §1.3 |
| J4 | **数据库是并行测试的唯一硬瓶颈**。不做 per-agent DB 隔离时，集成+E2E（1,185 Agent-分钟）必须串行，总工期锁死在 **27.6 小时**，此时把 Agent 从 4 个加到 16 个**收益严格为零**。 | §6.3 |
| J5 | **推荐 8 个并行 Agent + DB 隔离**：墙钟 **≈20.5 小时**（P50，≈2.9 个工作日），相对单 Agent 加速 **4.50×**，并行效率 56%。再往上加人收益递减（12 Agent → 17.1h，16 Agent → 15.5h，效率降至 37%）。 | §6.5 |

### 0.3 勘察副产品：已确认缺陷（建议单独立项）

详见 §1.5。其中最严重的一条是**附件上传/删除功能实际不可用**（BigInt 序列化 500），且它被现有"绿色"测试完全掩盖。

---

## 1. 勘察结论：现状基线

### 1.1 系统画像

| 维度 | 事实 |
| --- | --- |
| 后端 | NestJS 11 + Express 5 + Prisma 6，`apps/api/src` 134 个 `.ts` / 10,202 行 |
| 前端 | Next.js 15 App Router + React 19，`apps/web` 79 个源码文件 / 5,039 行（61 `.tsx` + 18 `.ts`） |
| 数据模型 | 79 个 Prisma model，63 个 migration，schema 2,229 行 |
| API 面 | **37 个控制器 / 352 个端点 / 46 个 service** |
| 前端面 | 21 个 `page.tsx`、38 个组件、16 个 lib 模块 |
| 全局前缀 | `/api/v1`（`apps/api/src/main.ts:14`） |
| 契约文档 | `docs/design/global-api-contract.md`（已确认，强制 `{data,meta}` / `{error,meta}`） |
| 自述测试方案 | `docs/design/testing-system-and-tooling-plan.md`（V1.0，状态"已实施，真实链路环境待接通"） |

### 1.2 测试资产盘点（本次实跑测定，非估算）

| 层 | 目录 | 文件 | 声明用例 | 实跑结果 | 状态 |
| --- | --- | ---: | ---: | --- | --- |
| 后端领域 | `apps/api/test/*.test.cjs` | 19 | 144 | 144 pass / 0 fail | ✅ 绿 |
| 后端单元 | `apps/api/test/unit/**` | 48 | 271 | 271 pass / 0 fail | ✅ 绿 |
| 后端 HTTP | `apps/api/test/http/**` | 5 | 10 | 未执行 | ⛔ 环境阻断 |
| 后端集成 | `apps/api/test/integration/**` | 5 | 6 | 未执行 | ⛔ 环境阻断 |
| 前端 lib | `apps/web/lib/*.test.mjs` | 19 | 96（实跑 108） | 108 pass / 0 fail / 0.76s | ✅ 绿但未接线 |
| E2E | `tests/e2e/*.spec.mjs` | 4 | 5 | 未执行 | ⛔ 环境阻断 + 1 例已知失败 |
| 夹具/助手 | `tests/{helpers,fixtures}`、`apps/api/test/helpers` | 6 | — | — | 163 行，stub 级 |

**总量**：100 个测试文件 / 532 个声明用例；测试代码 8,832 行 vs 生产代码 ≈17,400 行（比值 ≈0.51，但分布严重失衡）。

**实测执行成本**：

| 命令 | 耗时 | 说明 |
| --- | --- | --- |
| `npm run test:unit`（含 api build） | **22.5 s** | 415 用例 |
| 纯测试（不含 build） | **7.99 s** | 415 用例，≈19ms/用例 |
| `apps/web` 的 `test:unit` | **0.76 s** | 108 用例 |
| 单元测试固定成本（`nest build`） | ≈14.5 s | 每次门禁都要付 |
| 环境探针 | **Docker daemon 未运行**；`5432` 无监听；`TEST_DATABASE_URL`/`API_BASE_URL`/`PLAYWRIGHT_BASE_URL` 三个变量**全为空** | 链路三层 100% 阻断 |

> **性能判断**：后端单元测试成本极低（≈19ms/用例），这是本项目最好的资产——意味着"单元测试多"这一原则**几乎零边际成本**，可以放心把用例量推到 1,000+ 级别。

### 1.3 现有测试体系成熟度评级

| 能力项 | 成熟度 | 证据 |
| --- | --- | --- |
| 分层脚本语义 | 🟡 部分 | `package.json:12-23` 已分 unit/api/integration/e2e，**但 `test` 只跑 unit，且不含 typecheck**（与自述方案 `testing-system-and-tooling-plan.md:84` 不符） |
| 环境阻断不降级 | 🟢 良好 | `scripts/run-tests.mjs:17-30` 缺变量即 `exit 3`；`docs/test/results/latest-chain-quality-gate.md` 如实记录 4 项全阻断。**这个设计值得保留** |
| 结果归档 | 🟢 良好 | `scripts/verify-quality.mjs:15-17` 输出 Markdown 并脱敏；`docs/test/results/` 有 30+ 份历史报告 |
| 后端单元测试 | 🟢 可用 | 77 文件 / 7,324 行，`node:test` + 编译后 `dist` 加载，无需 ts-node |
| Nest 测试宿主 | 🔴 缺失 | `@nestjs/testing` 在 `apps/api/package.json:33` 是 devDependency，但**全仓库零引用**——从未装配过 module/controller/guard/interceptor |
| HTTP 契约测试 | 🔴 严重不足 | 352 端点中 **333 个（94.6%）无 HTTP 测试**；已触达的 19 个里仅 3 个有正向断言 |
| 集成测试 | 🔴 严重不足 | 5 文件 / **6 用例**，覆盖 79 个 model 的数据流 |
| 并发/幂等真实验证 | 🔴 缺失 | 所有 `*-lock` 测试只断言 fake Prisma 被调用过；fake `$transaction` 就是 `async (fn) => fn(tx)`，**没有回滚语义** |
| 前端组件测试 | 🔴 不存在 | `apps/web/test/` 只有 `.gitkeep`；无 RTL / jsdom / vitest / jest / MSW；**零组件渲染** |
| 前端 lib 测试 | 🟡 有水分 | 12/19 文件用 `readFileSync` 读源码做正则断言（`refresh-policy.test.mjs:29` 甚至钉死 `onClick={() => void load()}>刷新<`）——等价重构即误红，运行时缺陷全漏 |
| E2E | 🟡 有但不可复现 | 4 spec / 5 用例；`production-daily-report.spec.mjs:7` 等硬抛 `TEST_BLOCKED`；存档 `playwright-result.json` 为 **1 failed / 0 passed** |
| 稳定性测试钩子 | 🔴 缺失 | 全前端 `data-testid` 计数 = **0**；已知 P0 阻塞正是 label 定位超时（`test-results/.../error-context.md`：`getByLabel('地点名称')` timeout） |
| CI 接线 | 🔴 缺失 | `.github/workflows/deploy.yml` 无任何 test 步骤 |
| 覆盖率工具 | 🔴 缺失 | 无 coverage 脚本，无 c8/nyc/@vitest/coverage-v8 |
| 夹具工厂 | 🟢 已建立（W1） | `tests/fixtures/factories.cjs`：跨模块链路工厂 + DMMF 派生清理 + 整轮重试收敛；实测零残留。替代原 13 行 stub |
| 测试用户与 RBAC 种子 | 🟢 已建立（W1） | `tests/fixtures/seed-users.cjs`：8 种角色（含零权限用户）+ 会话签发；原 `test-users.cjs` 是零引用的死夹具 |
| 契约测试 harness | 🟢 已建立（W1） | `tests/helpers/api-client.cjs`：Cookie 会话登录 + 信封/状态码断言；修掉"Bearer 头后端不认"的静默失效缺陷 |
| 跨模块不变量断言 | 🟢 已补齐（W1） | `tests/helpers/business-invariants.cjs`：6 → **25 个断言**，含精确十进制运算、状态机、幂等、冲销保留原事实 |

**综合评级：C（骨架成立，中层缺失，自动化闭环未闭合）**

### 1.4 与项目自述测试方案的偏差

`docs/design/testing-system-and-tooling-plan.md` 自身质量很高，问题在于**只落地了约 35%**：

| 自述方案要求 | 位置 | 实际状态 |
| --- | --- | --- |
| 每切片含 E2E 主路径 + 负向 + 回退 + 并发/幂等 | `:39` | ❌ 集成仅 6 例，全阻断 |
| `apps/web/test/` 组件/交互测试 | `:98` | ❌ 仅 `.gitkeep` |
| 14 个链路夹具工厂 | `:134-145` | ❌ 仅 4 个对象构造器 |
| `assertBusinessInvariant` 断言库 | `:156-187` | 🟡 6/10 类不变量 |
| 5 类测试用户角色 | `:120-126` | ❌ 23 行常量表，无 seeding |
| `docs/test/cases/` 链路用例 | `:102` | ❌ 仅 README |
| HTTP 门禁：RBAC/403、来源版本、分批到货、幂等过账 | `:212` | ❌ 0 |
| 覆盖率工具 | `:72` | ❌ 无脚本 |
| CI 接入 | `:263`、`:9` | ❌ workflow 无测试步骤 |
| `npm run test` = unit+build+typecheck | `:84` | 🟡 缺 typecheck |

### 1.5 勘察副产品：已确认缺陷与风险

> 以下均为本次勘察中**静态可证实**的发现，按严重度排序。建议在测试工程之外**单独立项修复**——它们本身就是"该被测试发现却因测试缺失而存活"的证据。

| # | 严重度 | 缺陷 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | **P0 功能阻断** | `POST /api/v1/attachments` 与 `DELETE /api/v1/attachments/:id` 必然 500 | `schema.prisma:190` `fileSize BigInt`（全库唯一 BigInt 字段）；`attachments.service.ts:24,43` 返回整行含 `fileSize`；全仓库无 `BigInt.prototype.toJSON` 补丁（已 grep，0 命中） | 附件上传/删除**完全不可用**；`apps/web/app/warehouse/page.tsx:57` 依赖此接口 |
| D2 | P1 契约违背 | `meta.request_id` 恒不出现在响应体 | `request-id.middleware.ts:7-8` 只写**响应头** + `request.id`；拦截器/过滤器读的是**请求头** `request.header("x-request-id")`（`response-envelope.interceptor.ts:9`、`api-exception.filter.ts:24`） | 违背 `global-api-contract.md:31`；追踪只能靠响应头。**更糟：`apps/api/test/http/platform-http.test.cjs:12` 用 `assert.deepEqual(body.meta, {})` 把这个 bug 固化成"预期"** |
| D3 | P1 权限真空 | 前端**没有任何权限层** | 全库无 `role`/`permission`/`can*` 判定；`app-shell.tsx:12-21` 对任何登录用户全量渲染导航；无 403 处理（仅注释提及）；401 只在 AppShell 挂载时判定一次（`:31-34`） | 非授权模块菜单可见；前台会话过期不跳登录；无权限与"真没数据"在 UI 上不可区分（6 处 `.catch(() => ({data:[]}))` 静默降级） |
| D4 | P1 重复提交 | 防重复提交大面积缺失 | 全库 `useTransition`/`isPending` = **0**；唯一强守卫是 `components/ui/action-dialog.tsx:18,28,30`（且**零测试**）；**18 个文件共 153 个 `<Button>` 但 `disabled=` 计数为 0**，含 `app/hr/page.tsx`（1064 行、10 按钮、`action()` 无 in-flight 标志）、`organization-pool.tsx:32`（连点发重复 DELETE）；13 个 `run()/action()/request()` 封装**全部无 in-flight 标志** | 双击/连点导致重复建单、重复 DELETE、重复过账请求 |
| D5 | P1 死代码 | `StateMachineService` 注册但无人注入 | `state-machine.service.ts`（38 行）仅被 `app.module.ts:10,24` 与自身 module 引用 | 状态机保护可能形同虚设，需确认是否仍有意使用 |
| D6 | P1 测试盲区 | `module-permission.guard.ts` 被 34 个控制器使用，**零测试** | 全仓库无任何 403/RBAC/模块隔离测试 | 权限回归无护栏 |
| D7 | P2 契约不一致 | `meta.total` 语义分裂 | `reports.service.ts:11` 用 `count(where)`（✅正确）vs `:12,13,14,15` 用 `rows.length`（❌本页行数） | 4 个报表端点分页器会认为只有 1 页 |
| D8 | P2 契约不一致 | `sort` 参数全局声明但**从未实现** | `pagination-query.dto.ts:20`，全仓库无消费点 | 客户端传 `sort` 静默无效 |
| D9 | P2 校验分裂 | 未知参数：部分 400、部分静默忽略 | `main.ts:19-28` 的 `ValidationPipe` 只对 class metatype 生效；`@Query() q: {order_no?: string}`（TS 字面量→运行时 `Object`）跳过全部校验。涉及 6 个端点（`operation-daily-reports.controller.ts:20` 等） | 同一 API 面对未知参数行为不一致，客户端无法依赖 |
| D10 | P2 校验缺陷 | 嵌套 DTO 校验错误**丢失 `details`** | `api-exception.filter.ts:26` 只读顶层 `error.constraints`，不递归 `error.children` | `PurchaseOrderDto.items[]`、`FormDefinitionDto.fields[]` 等嵌套失败返回 `details: []`，客户端无法定位字段 |
| D11 | P2 部署风险 | CORS 未开 credentials | `main.ts:15` `app.enableCors()` 无 origin 白名单、未开 credentials；前端用 `credentials: "include"`（`api-client.ts:17,32`） | 同源部署才成立；跨域部署 cookie 不发送。**未验证是否跨域部署** |
| D12 | P2 孤儿接口 | 6 类接口前端无调用点 | `GET /production/payroll-sources`、`GET /dictionaries/*` 等（`00-recon-api-contract.md` M6） | 需确认是否为对外承诺接口 |
| D13 | P2 死代码 | `ApiError`、`apiSuccess`/`paginated`、`PaginationQueryDto.sort`、`lib/adapters/*`（demo 数据）、`module-placeholder.tsx` 均无调用点 | 各自 grep 0 命中 | 增加认知负担，误导覆盖率判断 |
| D14 | P2 导出编码 | 12 个 `@Res()` 端点 `Content-Disposition` 三种写法混用 | `production-payroll-export.controller.ts:21-24` 用 `filename*`；`production-master-data.controller.ts:66` 用 `filename=`；`reports.controller.ts:11` 用 `filename="${report}.csv"` | 中文文件名可能乱码。**未实测** |

---

## 2. 脚手架研判：需要补全，但要精准

### 2.1 结论

**需要补全。** 但补全范围必须严格限定，避免把已经好用的东西推倒重来。

判断依据有三条：
1. **能力强项应保留**：`node:test` 后端单测（19ms/用例）、`run-tests.mjs` 的"环境阻断即 exit 3 不降级"语义、`verify-quality.mjs` 的结果归档与脱敏——这三项质量高于多数同类项目，**不要换成 Jest**。
2. **能力缺项是阻断级**：前端组件测试工具链缺失 → 客户要求的"事件绑定/状态更新/加载态/错误态/防重复提交"六项**一项都无法测**；测试 DB 无隔离 → 集成/E2E 无法并行编写；CI 无测试步骤 → 所有测试都是"可选动作"。
3. **现有资产有水分**：前端"108 个绿色用例"里 12/19 文件是源码正则断言，**必须改造而非叠加**，否则会形成"用例数很好看、缺陷照样漏"的假安全。

### 2.2 逐项判定表

#### A. 复用（保留，不改）

| 资产 | 位置 | 保留理由 |
| --- | --- | --- |
| 后端 `node:test` + 编译后 `dist` 加载 | `apps/api/test/**/*.test.cjs` | 7.99s / 415 用例；无需 ts-node/webpack 别名，启动成本极低 |
| 分层脚本 + 环境阻断语义 | `scripts/run-tests.mjs` | 缺失依赖即 `exit 3`，不伪装成通过——这是本项目最好的测试设计 |
| 结果归档与脱敏 | `scripts/verify-quality.mjs` | 输出 Markdown、脱敏 password/token/cookie、区分"失败/环境阻断" |
| Playwright + 固定 Chromium | `playwright.config.mjs`、本地已装 chromium-1234 | E2E 工具已就位，无需新增 |
| 迁移守卫工具 | `apps/api/test/helpers/migration-guards.cjs` | 从 migration SQL 推演"活着的唯一约束"，思路独特且已解决过真实 bug |
| Prisma 迁移准备 | `scripts/prepare-test-database.mjs` | 已有"必须指向 test 库"的强制校验 |

#### B. 必须补全（阻断级，不补则后续全部工作无法开展）

| # | 补全项 | 现状 | 目标产物 | 阻塞的客户需求 |
| --- | --- | --- | --- | --- |
| S1 | **前端组件测试工具链** | 全缺（无 vitest/jest/RTL/jsdom/MSW，零组件渲染） | `apps/web/vitest.config.ts` + `apps/web/test/setup.ts` + devDeps：`vitest`、`jsdom`、`@testing-library/react`、`@testing-library/user-event`、`@testing-library/jest-dom`、`msw`（或 fetch stub 约定） | 交互测试、事件绑定、状态更新、加载态、错误态、防重复提交、数据流 |
| S2 | **测试数据库隔离能力** | 单一 `TEST_DATABASE_URL`；所有集成/E2E 串行 | `scripts/provision-test-databases.mjs`（建 N 个 `dilee_test_01..N`）+ 每 worker 端口/库名注入 + `.env.test.example` | 集成测试、E2E、并发验证；**也是 §6 并行成本的关键杠杆** |
| S3 | **夹具工厂库** | `business-fixtures.cjs` 13 行 / 4 个构造器 | `tests/fixtures/factories.cjs`：按自述方案 `:134-145` 实现 14 个工厂（`createCustomer` … `postInbound`），全部走业务 API 或 Prisma 测试客户端，返回真实 id | 集成测试、E2E（当前每个 E2E spec 手写 14 行 Prisma seeding，见 `production-daily-report.spec.mjs:11-12`） |
| S4 | **测试用户与 RBAC seeding** | `test-users.cjs` 23 行，**零引用**（死夹具） | `tests/fixtures/seed-users.cjs`：按 `:120-126` 落地 `sales_operator`/`procurement_operator`/`warehouse_operator`/`finance_operator`/`administrator` 五种角色 + 独立会话，测试后清理 | 权限测试（401/403、模块隔离、管理员短路） |
| S5 | **CI 接线** | `.github/workflows/deploy.yml` 无任何 test 步骤 | 新增 `.github/workflows/test.yml`：push/PR 跑快速门禁（typecheck + 后端单测 + 前端单测 + 双 build）；定时/手动跑链路门禁（postgres service + integration + http + e2e） | 全部（否则测试永远是可选项） |
| S6 | **`data-testid` 稳定性钩子** | 全前端计数 **0**；已知 P0 阻塞即 label 定位超时 | 21 个 `page.tsx` + 9 个业务 panel 的关键交互元素补 `data-testid`；E2E 全面改用 `getByTestId` | E2E 稳定性；当前 4 个 spec 有 1 个已失败 |
| S7 | **覆盖率与报告归档脚本** | 无 coverage 工具 | `package.json` 增 `test:coverage`（`node --experimental-test-coverage` + vitest coverage），输出到 `docs/test/results/` | 趋势度量（仅作趋势，不作唯一指标——沿用 `0821-03` 决策） |
| S8 | **环境解阻 runbook** | Docker daemon 未运行、3 个 env 变量全空 | `docs/test/02-test-environment-runbook.md` + `scripts/dev-test-up.ps1`（起 postgres → `db:test:prepare` → 起 api → 起 web → 导出 3 个变量） | 集成/E2E 无法执行 |

#### C. 建议补全（效率级，显著降低后续单位成本）

| # | 补全项 | 现状 | 目标产物 |
| --- | --- | --- | --- |
| S9 | HTTP 契约测试宿主 | 无统一 harness；`tests/helpers/api-client.cjs` 只有 13 行且用了后端不认的 `Bearer` 头 | 扩充 api-client：cookie 会话登录、`x-request-id` 断言、响应头断言、按角色登录工厂 |
| S10 | 跨模块不变量断言补全 | 6 个断言 | 补金额/余额守恒、状态机合法性、幂等（事实不翻倍）、冲销保留原事实、软删来源不可引用 |
| S11 | 前后端路由契约差集测试 | 无 | 静态断言：遍历 `apps/web` 的 `/api/v1` 调用路径集合与后端路由集合求差，报出孤儿/缺失 |
| S12 | 契约不变量回归护栏 | 无 | 把 §1.5 的 D2/D7/D8/D9/D10 固化为"当前行为"测试，标注为待修契约缺陷（防止悄悄改变） |

#### D. 明确不引入（避免过度工程）

| 不引入 | 理由 |
| --- | --- |
| Jest / Cypress | 与现有 `node:test` / Playwright 重复；自述方案 `:61` 已明确"避免为简单规则引入新测试框架" |
| Cucumber / BDD 层 | 单人+小团队厂内 ERP，收益低于维护成本 |
| Pact broker / 消费者驱动契约平台 | 前后端同仓库同提交，静态差集（S11）已足够 |
| 变异测试 | 当前首要矛盾是"中间层为空"，不是"断言强度不足" |
| k6 / 混沌工程 | 自述方案 `:279` 明确暂不纳入；已有 `scripts/perf-gate.mjs` 轻量门禁 |
| 大规模快照测试 | 自述方案 `:280` 明确排除 |
| 外部系统接口契约测试 | 自述方案 `:278` 明确排除 |

### 2.3 脚手架工作量汇总

| 组 | 项 | 估算（Agent-分钟） |
| --- | --- | ---: |
| B 阻断级 | S1 前端工具链 | 60 |
| | S2 测试 DB 隔离 | 50 |
| | S3 夹具工厂 | 90 |
| | S4 测试用户 RBAC | 45 |
| | S5 CI 接线 | 75 |
| | S6 `data-testid` 插桩 | 60 |
| | S7 覆盖率脚本 | 30 |
| | S8 环境 runbook | 30 |
| C 效率级 | S9 契约 harness | 35 |
| | S10 不变量补全 | 60 |
| | S11 路由差集测试 | 30 |
| | S12 契约护栏 | 45 |
| | 共享配置合并/验证（串行） | 60 |
| **合计** | | **670** |

---

## 3. 测试策略与目标金字塔

### 3.1 配比目标（对齐"单元多 / 集成中 / E2E 精"）

| 层 | 现状用例 | 目标用例 | 现状文件 | 目标文件 | 定位 |
| --- | ---: | ---: | ---: | ---: | --- |
| 后端纯函数/DTO/策略 | ~60 | **240** | 6 | 26 | 快速规则反馈，毫秒级 |
| 后端 service 单元 | 355 | **1,050** | 48 | 95 | 复杂规则、状态判定、金额算术（fake Prisma） |
| 前端 lib 单测（**改造为行为测试**） | 108 | **180** | 19 | 22 | 序列化、超时、格式化、适配 |
| 前端组件/交互测试 | **0** | **440** | **0** | **38** | 事件绑定、状态更新、加载/错误态、防重复提交 |
| HTTP / 接口契约 | 10 | **900** | 5 | 42 | 352 端点 × (正向 + 负向 + 鉴权) + 横切契约 |
| 集成（真实 PG） | 6 | **150** | 5 | 20 | 数据流、事务回滚、真实约束 |
| 并发 / 幂等（真实 PG） | 0 | **40** | 0 | 7 | 双击、并发过账、同键重放 |
| E2E（Playwright） | 5 | **28** | 4 | 10 | 关键纵向链路，主路径 + 1~2 负向 |
| **合计** | **532** | **≈3,028** | **100** | **≈260** | |

**配比结果**：单测（后端+前端）≈1,910 / 契约 900 / 集成+并发 190 / E2E 28
→ 单测 : 集成 : E2E ≈ **68 : 7 : 1**，其中"集成"含 900 例接口契约层。**符合"单元多、集成中、E2E 精"。**

> **说明**：HTTP 契约层放在"集成"与"单元"之间——它不需要真实业务数据但需要运行中的 API，成本低、杠杆高，是补"腰部"性价比最高的一层。**900 例是本次规划的重点投入。**

### 3.2 分层职责与准入准则

| 层 | 该层**必须**证明 | 该层**不该**做 |
| --- | --- | --- |
| 后端单元 | 纯决策逻辑：状态判定、数量/金额算术、DTO 校验、错误码映射、单号生成 | 不断言 SQL、不依赖真实约束 |
| 前端组件 | 渲染结果、事件回调被调用、`disabled`/loading 态、错误文案、重复提交被拒 | 不断言 JSX 书写形式（**取缔正则断言**） |
| HTTP 契约 | 信封形状、状态码、错误码、鉴权矩阵、分页/排序/过滤、校验分裂行为 | 不验证业务算术（那是单元/集成的事） |
| 集成 | 真实约束、事务原子性、`order_no` 贯穿、来源版本、失败无半成品 | 不重复单元已覆盖的分支枚举 |
| 并发/幂等 | 同键重放不产生第二组事实；并发过账恰好一个成功；无负库存 | 不做性能压测 |
| E2E | 用户可见的纵向链路闭合（登录 → 单据 → 下游事实 → 工作台可见同一 `order_no`） | 不枚举边界值、不做逐字段校验 |

### 3.3 E2E 选定链路（10 条，"精"）

| # | 链路 | 现状 | 优先级 |
| --- | --- | --- | --- |
| E1 | 认证 + 权限门禁（匿名跳登录、无权限模块不可见/不可操作） | 🟡 仅 2 例认证 | P0 |
| E2 | 客户 → 销售单 → 确认 → BOM | ❌ | P0 |
| E3 | 采购单 → 分批到货 → 来料 QC → 原料入库 → 应付来源 | 🟡 存档失败 | P0 |
| E4 | 生产单 → 领料 → 工序/员工日报 → 进度 | 🟡 `production-daily-report` 环境阻断 | P0 |
| E5 | 成品送检 → 成品 QC → 成品入库 | ❌ | P1 |
| E6 | 成品出库 → 应收 → 收款核销 | ❌ | P1 |
| E7 | 应付 → 供应商付款 → 核销 | ❌ | P1 |
| E8 | 薪资台账 → 工资应付 → 工资支付 | ❌ | P1 |
| E9 | 报警中心 + 报表导出（xlsx/csv 下载） | ❌ | P2 |
| E10 | 订单全链路工作台（同一 `order_no` 贯穿可见） | ❌ | P1 |

---

## 4. 工作分解（WBS）与工作量估算

**估算口径**：1 个"工作单元" = 1 个测试文件，含"读生产代码 → 写用例 → 实跑 → 修到绿"的完整闭环（Agent-分钟）。不含返工缓冲。

| 阶段 | 工作单元 | 数量 | 单位成本 | 小计（Agent-分钟） |
| --- | --- | ---: | ---: | ---: |
| **P0 脚手架** | 见 §2.3 | 14 项 | — | **670** |
| **P1 后端单元** | service 单元文件（补/扩） | 47 | 15 | 705 |
| | 纯函数/DTO/策略文件 | 20 | 15 | 300 |
| | 平台层（guards/interceptor/filter/middleware/env/sequence/prisma-error） | 8 | 15 | 120 |
| | 根领域测试文件（补/扩） | 7 | 15 | 105 |
| **P2 HTTP / 契约** | 每控制器契约文件（37 个控制器） | 37 | 22 | 814 |
| | 横切契约套件（信封/错误码/状态矩阵/分页一致性/导出旁路/校验分裂） | 5 | 22 | 110 |
| **P3 集成 / 事务 / 并发** | 模块级数据流集成文件 | 15 | 35 | 525 |
| | 事务回滚文件 | 3 | 30 | 90 |
| | 并发文件（真实并发事务） | 4 | 45 | 180 |
| | 幂等文件（同键重放） | 3 | 40 | 120 |
| **P4 前端** | lib 改造为行为测试 | 19 | 12 | 228 |
| | 共享 UI kit 组件（24 个组件 → 14 文件） | 14 | 22 | 308 |
| | 共享 data/feedback 组件 | 4 | 20 | 80 |
| | 业务 panel（production/warehouse 9 个） | 9 | 28 | 252 |
| | 页面级交互（21 页 → 12 文件，HR 1064 行单独 1 文件） | 12 | 30 | 360 |
| **P5 E2E** | 新增/修复 spec | 6 | 45 | 270 |
| **P6 收敛** | 全链路门禁跑通 + 稳定化 + 归档 | 1 | 300 | 300 |
| | **合计** | | | **5,537** |

> **≈ 5,537 Agent-分钟 ≈ 92.3 Agent-小时**（含 P6 收敛）。
> 若不计收敛，纯编写量 ≈ 5,237 Agent-分钟 ≈ 87.3 Agent-小时。
> 换算：单 Agent 串行 ≈ **13.2 个工作日**（按 7 h/有效日）。

### 4.1 各阶段产出与退出准则

| 阶段 | 产出 | 退出准则（必须可验证） |
| --- | --- | --- |
| **P0 脚手架** | 工具链配置、夹具工厂、CI workflow、DB 隔离脚本、runbook、`data-testid` | ① `npm run test:unit` 一条命令同时跑后端+前端；② Docker 起来后 `runbook` 三步内让 integration/http/e2e 从 `exit 3` 变为可执行；③ CI 在 PR 上真实跑测试并可见红绿 |
| **P1 后端单元** | 95 个 unit 文件 + 26 个纯函数文件 | 用例数 ≥1,290（含现有 415），全绿，纯执行 <60s |
| **P2 HTTP / 契约** | 42 个契约文件 | 352 端点 100% 至少有一条正向或鉴权断言；状态码 200/201/204/400/401/403/404/409/413/422/500/503 各 ≥1 例；鉴权矩阵 37 控制器全覆盖 |
| **P3 集成 / 并发** | 20 个集成 + 7 个并发/幂等文件 | 真实 PG 下：`order_no` 贯穿断言通过；失败无半成品断言通过；同键重放事实不翻倍；并发过账恰好一个成功且无负库存 |
| **P4 前端** | 58 个前端测试文件 | 「六项维度」每项 ≥1 个断言文件：事件绑定、状态更新、API 调用、加载态、错误态、防重复提交；**删除或改造全部 12 个源码正则断言文件** |
| **P5 E2E** | 10 个 spec | 每条链路一条主路径用例通过；E1 含匿名/无权限负向；全绿可重复三次 |
| **P6 收敛** | `docs/test/results/latest-chain-quality-gate.md` 全 0 退出码 | 无 `exit 3` 阻断项；全套链路门禁墙钟 <10 分钟 |

---

## 5. 排期规划

### 5.1 阶段排期（按 8 个并行 Agent 计）

波次墙钟 = 该波次工作量 ÷ 投入 Agent 数。所有数字可由 §4 的工作量直接复算。

| 波次 | 内容 | 工作量(Agent-分钟) | Agent 数 | 波次墙钟 | 累计 |
| --- | --- | ---: | ---: | ---: | ---: |
| **W0** | 环境解阻（S8）+ 地基 A（S1 工具链 / S2 DB 隔离 / S5 CI / S7 覆盖率） | 245 | 3 | 1.4 h | 1.4 h |
| **W1** | 地基 B（S3 夹具工厂 / S4 测试用户 / S9 契约 harness / S10 不变量）——**夹具接口在此冻结** | 230 | 3 | 1.3 h | 2.6 h |
| **W2** | `data-testid` 插桩（S6）+ 契约护栏（S12）+ 路由差集（S11），同时启动 P1 | 135 | 2 | 1.1 h | 3.8 h |
| **W3** | **P1 后端单元主扇出**（95 + 26 文件） | 1,230 | 8 | 2.6 h | 6.3 h |
| **W4** | **P2 HTTP / 契约**（42 文件，共享运行中的 API） | 924 | 8 | 1.9 h | 8.3 h |
| **W5** | **P4 前端**（58 文件，与后端完全独立） | 1,228 | 8 | 2.6 h | 10.8 h |
| **W6** | **P3 集成 / 并发 / 幂等**（27 文件，需 per-agent DB） | 915 | 8 | 1.9 h | 12.7 h |
| **W7** | **P5 E2E**（6 spec，需 per-agent DB + 端口） | 270 | 5 | 0.9 h | 13.6 h |
| **W8** | **P6 收敛**：全门禁跑通、稳定化、归档 | 300 | 1（串行） | 5.0 h | **18.6 h** |
| | **合计** | **5,537** | | | **18.6 h** |

**两种口径的交叉验证**：

| 口径 | 结果 | 说明 |
| --- | ---: | --- |
| 解析模型 `T(N)=S+P(1+c)/N`（N=8） | **20.5 h** | 保守，含 20% 协调开销 |
| 波次实现表（上表） | **18.6 h** | 乐观，假设波次无空隙 |
| **预测区间（P50）** | **≈19 ~ 20.5 h** | 取两者之间 |

> **推荐排期：≈20 墙钟小时 ≈ 2.9 个工作日**（按 7 h/有效日计）。
> **含 20% 返工缓冲的承诺排期（P80）：≈24.6 h ≈ 3.5 个工作日 → 对外承诺 4 个工作日。**

### 5.2 关键路径

**有 DB 隔离时**（关键路径短于总工期 → 说明"加 Agent 有效"）：

```
环境解阻(W0) → 夹具接口冻结(W1) → P3集成编写(W6) → P6收敛(W8)
   1.4h            1.3h              1.9h           5.0h
                                        合计 ≈ 9.6 h
```

关键路径 9.6 h < 总墙钟 20 h，**工期由并行扇出总量决定，而非串行链**。这是"必须加 Agent"的前提。

**无 DB 隔离时**（关键路径反超总工期 → "加 Agent 无效"）：

```
P3 集成(915min=15.3h) → P5 E2E(270min=4.5h) → P6 收敛(5.0h)
                                        合计 ≈ 24.8 h 串行
```

且该链**与 Agent 数量无关**——这是 J4 判断的量化依据，也是 S2（DB 隔离）优先级最高的原因。

### 5.3 前置条件与依赖

| # | 前置条件 | 阻塞范围 | 责任 |
| --- | --- | --- | --- |
| R1 | 启动 Docker Desktop（本机已安装，WSL `docker-desktop` 已就绪，仅 daemon 未运行） | 全部集成/E2E | 环境 |
| R2 | 建立 `dilee_test` 专用库（`TEST_DATABASE_URL` 必须含 `test`，已被 `test-context.cjs:11` 强制） | 集成/E2E | 环境 |
| R3 | 前端工具链选型确认（Vitest 建议，见 §2.2 S1） | 全部前端测试 | 决策 |
| R4 | 是否跨域部署（决定 D11 是否真缺陷） | CORS 契约用例 | 产品 |
| R5 | D1 附件 BigInt 缺陷是否先修（影响附件契约用例的期望值） | 附件相关 4 用例 | 产品 |
| R6 | 「无权限」在 UI 上的期望行为（隐藏菜单 or 显示但禁用 or 403 页） | 前端权限测试断言 | 产品 |

> **R6 尤其重要**：D3 指出前端当前**没有任何权限层**。若产品期望"无权限即隐藏"，那是**功能开发**而非测试补全，需单独排期，不在本文档工作量内。

---

## 6. 多 Agent 并行时间成本预测

### 6.1 模型假设与参数

**并行加速模型**（Amdahl 形式 + 协调开销）：

```
T(N) = S + P × (1 + c(N)) / N
```

| 参数 | 取值 | 含义与依据 |
| --- | --- | --- |
| **总工作量** | **5,537 Agent-分钟 ≈ 92.3 h** | §4 合计（可逐行复算） |
| `P` 可并行部分 | **5,067 Agent-分钟** | 后端 97 单测文件 + 42 契约文件 + 27 集成文件 + 58 前端文件 + 6 E2E + P0 中文件互不重叠的部分，均为**独立新文件**，写入互不冲突 |
| `S` 串行部分 | **470 Agent-分钟** | ① P0 中的共享文件编辑与决策冻结（`package.json`、`playwright.config.mjs`、`business-invariants.cjs`、CI workflow、夹具接口评审）≈170；② P6 全门禁收敛与稳定化 =300 |
| `c(N)` 协调开销 | 见下表 | 来源：接口契约对齐、共享文件写冲突、夹具 API 变更引发的返工、Agent 间结论复核 |
| 有效日 | 7 h | 扣除人工评审、环境等待、Agent 上下文重建 |

| N | `c(N)` | 依据 |
| ---: | ---: | --- |
| 1 | 0% | 无协调 |
| 2 | 5% | 仅需对齐夹具接口 |
| 4 | 10% | 共享文件开始出现写冲突 |
| 6 | 15% | 接近单文件安全扇出上限 |
| 8 | 20% | 需分批扇出；5 个热点文件串行化提交 |
| 10 | 26% | 开始等待共享资源（API 实例、构建产物） |
| 12 | 32% | DB/端口成为真实约束；结论复核成本上升 |
| 16 | 45% | 协调开销吞噬并行收益 |

### 6.2 单 Agent 基线（串行）

| 阶段 | Agent-分钟 | 墙钟（h） |
| --- | ---: | ---: |
| P0 脚手架 | 670 | 11.2 |
| P1 后端单元 | 1,230 | 20.5 |
| P2 HTTP 契约 | 924 | 15.4 |
| P3 集成/并发 | 915 | 15.3 |
| P4 前端 | 1,228 | 20.5 |
| P5 E2E | 270 | 4.5 |
| P6 收敛 | 300 | 5.0 |
| **合计** | **5,537** | **92.3** |

### 6.3 瓶颈分析：数据库是唯一硬约束（核心结论）

**不加隔离时**，集成写入与 E2E 都必须独占测试库（唯一约束、`order_no` 前缀、清理顺序均要求独占）。因此这一段**无论多少 Agent 都无法并行**：

```
P3 + P5 = 915 + 270 = 1,185 Agent-分钟 ≈ 19.8 h  ← 强制串行链
```

此时总工期为：

```
T_noIsolation(N) = S + max(P3+P5, (P−P3−P5)×(1+c(N))/N)
```

| Agent 数（无隔离） | 墙钟 (h) | 相对单 Agent | 说明 |
| ---: | ---: | ---: | --- |
| 1 | 72.5 | 1.27× | 校验用：4,352 min |
| 2 | 41.8 | 2.21× | 仍有收益 |
| 4 | **27.6** | 3.35× | 已触及 DB 上限 |
| 8 | **27.6** | 3.35× | **加人零收益** |
| 16 | **27.6** | 3.35× | **加人零收益** |

> **这是本次规划中最高价值的工程洞察**：`S2 测试数据库隔离` 这一个 50 Agent-分钟的地基项，把项目的并行天花板从 **27.6 h 降到 20.5 h（−26%）**，并把"N≥4 后加人无效"变成"N≤10 近似线性"。**它是 4→8 Agent 能否提速的唯一开关，优先级应高于任何单个测试文件。**

**加隔离后**，每个 Agent 独占 `dilee_test_NN` + 独占 API 端口 + 独占 Web 端口，P3/P5 完全并行化。

### 6.4 三种并行度方案对比

| 方案 | N | DB 隔离 | 串行 S | 可并行 P | `c(N)` | 墙钟 T(N) | 加速比 | 并行效率 |
| --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **A** 单 Agent | 1 | — | 470 | 5,067 | 0% | **92.3 h** | 1.00× | 100% |
| **B** 小并行 | 4 | ✅ | 470 | 5,067 | 10% | **31.1 h** | 2.97× | 74% |
| **C** 中并行 | 6 | ✅ | 470 | 5,067 | 15% | **24.0 h** | 3.84× | 64% |
| **D 推荐** | **8** | ✅ | 470 | 5,067 | 20% | **20.5 h** | **4.50×** | **56%** |
| **E** 高并行 | 10 | ✅ | 470 | 5,067 | 26% | **18.5 h** | 5.00× | 50% |
| **F** 高并行 | 12 | ✅ | 470 | 5,067 | 32% | **17.1 h** | 5.39× | 45% |
| **G** 极高并行 | 16 | ✅ | 470 | 5,067 | 45% | **15.5 h** | 5.96× | 37% |
| **H** 8 Agent **无**隔离 | 8 | ❌ | 470 | — | — | **27.6 h** | 3.35× | 42% |
| **I** 16 Agent **无**隔离 | 16 | ❌ | 470 | — | — | **27.6 h** | 3.35× | 21% |

计算示例（方案 D）：
```
T(8) = 470 + 5,067 × 1.20 / 8 = 470 + 760 = 1,230 分钟 = 20.5 h
```

### 6.5 推荐方案与预测区间

| 项 | 预测 |
| --- | --- |
| **推荐并行度** | **8 个 Agent**（按文件/模块分片，见 §6.6） |
| **前置硬条件** | 必须完成 S2 测试数据库隔离 |
| **墙钟预测（P50）** | **≈19 ~ 20.5 小时 ≈ 2.9 个工作日** |
| **墙钟预测（P80，含 20% 返工）** | **≈24.6 小时 ≈ 3.5 个工作日** |
| **对外承诺排期** | **4 个工作日** |
| **相对单 Agent 加速** | **4.50×** |
| **并行效率** | **56%**（健康区间；低于 45% 即应减少 Agent） |
| **收益递减点** | 超过 **10 个 Agent** 后每增加 2 个 Agent 收益 < 2 h，而效率掉 6pp |
| **不建议超过** | **12 个 Agent**（17.1 h，仅比 8 Agent 快 3.4 h） |
| **反向警告** | 8 Agent **无** DB 隔离 = **27.6 h**，比 4 Agent 还慢，且完全浪费 4 个 Agent |

### 6.6 8 Agent 分片建议（最小化共享文件冲突）

| Agent | 负责范围 | 产出文件数 | 独占资源 |
| --- | --- | --- | --- |
| A1 | P0 地基：S1 前端工具链 + S7 覆盖率 + S5 快速 CI | 4 | — |
| A2 | P0/P1 地基：S2 DB 隔离 + S8 runbook + S5 链路 CI | 3 | DB 供给脚本 |
| A3 | S3 夹具工厂 + S4 测试用户 + S10 不变量（**串行前置，其余 Agent 等它冻结接口**） | 3 | — |
| A4 | P1 后端单元：production 模块（最大模块） | ~22 | — |
| A5 | P1 后端单元：procurement + warehouse | ~20 | — |
| A6 | P1 后端单元：finance + hr + sales + platform 层 | ~20 | — |
| A7 | P2 HTTP 契约（37 控制器 + 5 横切） | 42 | API 端口 3001 |
| A8 | P4 前端（58 文件） | 58 | vitest 进程 |
| **W6-W7 追加** | P3 集成/并发（27）+ P5 E2E（6）分给 A4-A8 复用（各自独立 DB） | 33 | `dilee_test_01..08` + 端口 3101-3108 / 3201-3208 |

**冲突热点（必须串行化提交）**：
`package.json`（根）、`playwright.config.mjs`、`tests/helpers/business-invariants.cjs`、`.github/workflows/*.yml`、`apps/web/package.json`。
→ 建议：**每个热点文件指定单一 owner**（分别是 A1/A1/A3/A1/A1），其他 Agent 以 patch 形式提交请求。

### 6.7 敏感性分析

| 变量 | 变化 | 对墙钟的影响 |
| --- | --- | --- |
| **DB 隔离缺失** | 有 → 无（N=8） | **20.5 h → 27.6 h（+35%）**；且 N>4 后加人严格零收益 |
| 夹具工厂延迟交付 | +90 分钟串行前置 | +1.5 h（所有集成/E2E/契约 Agent 空等） |
| R6「无权限 UI 行为」确认为**功能开发** | 新增前端权限层 | **+8~12 h**（超出本文档范围，需单独立项） |
| D1 附件缺陷先修 | 修复约 30 分钟 | −0.5 h（契约期望值变简单，无需固化"当前 bug 行为"） |
| 前端工具链选型反复 | Vitest ↔ Jest 来回 | +4~6 h（返工 19 个 lib 文件 + 配置） |
| E2E 无 `data-testid` | 跳过 S6 | E2E 阶段 +150%（选择器调试占主导，参考现有失败案例 70.5s 超时） |
| 环境始终不可用 | Docker 无法启动 | **整个计划无法执行**——当前即此状态，必须先解 R1/R2 |
| 协调开销上浮 | `c(8)` 由 20% → 35% | 20.5 h → 24.6 h（+4.1 h）；这是 P80 区间的主要来源 |

---

## 7. 门禁与 CI 落地

### 7.1 三级门禁

| 级别 | 触发 | 内容 | 目标时长 | 失败处理 |
| --- | --- | --- | --- | --- |
| **L1 快速门禁** | 每次 push / PR | `typecheck` → 后端单测（95+26 文件）→ 前端单测（vitest）→ api build → web build | **< 3 min** | 阻断合并 |
| **L2 链路门禁** | PR 打标签 / 每日定时 | postgres service → `db:test:prepare` → integration → http 契约 → e2e | **< 12 min** | 阻断合并；如实记录 `exit 3` 为环境阻断而非通过 |
| **L3 性能门禁** | 手动 / 每周 | `perf:gate`（3 端点 P95） + 备份恢复演练 | — | 记录趋势，不阻断 |

### 7.2 CI 配置要求

1. **`verify` job 必须补 `test:unit`**——当前 `.github/workflows/deploy.yml` 只做 typecheck + build。
2. **新增 PR 触发**——当前只在 `push: branches: [main]`，PR 完全不跑。
3. **L2 用 `services: postgres:16-alpine`** 并注入 `TEST_DATABASE_URL`，避免依赖外部 Docker。
4. **保留 `exit 3` 语义**——`run-tests.mjs` 的环境阻断必须映射为 CI 的 "blocked"，**不得降级为成功**（沿用 `testing-system-and-tooling-plan.md:242` 的决策）。
5. **归档测试报告**到 `docs/test/results/`，脱敏（已有 `verify-quality.mjs:12` 的脱敏逻辑可复用）。

### 7.3 目标 L2 时长测算

| 步骤 | 用例数 | 串行 | 并行度 | 目标 |
| --- | ---: | ---: | ---: | ---: |
| 后端单测 | 1,290 | 25 s | 1 | 25 s |
| 前端单测 | 620 | 40 s | 4 | 12 s |
| HTTP 契约 | 900 | 40 s | 4 workers | 12 s |
| 集成 | 150 | 110 s | 4 (per-worker DB) | 30 s |
| 并发/幂等 | 40 | 90 s | 2 | 45 s |
| E2E | 28 | 350 s | 4 workers | 90 s |
| 构建 + 迁移准备 | — | 60 s | — | 60 s |
| **合计** | **3,028** | — | — | **≈4.6 min** |

→ **余量充足**（目标 <12 min）。

---

## 8. 度量指标

| 指标 | 现状 | 目标 | 采集方式 |
| --- | --- | --- | --- |
| 端点 HTTP 覆盖率 | 5.4%（19/352） | **100%** | 契约测试清单 vs 路由清单差集 |
| 控制器鉴权矩阵覆盖 | ~3/37 | **37/37** | 契约测试清单 |
| 状态码覆盖 | 3/12 | **12/12** | 契约测试清单 |
| service 单测覆盖 | 46 中约 12 个有实质覆盖 | **46/46** | 文件对照 |
| 前端组件被测试引用数 | 10/61（且仅正则匹配） | **≥55/61** | 静态导入图 |
| 「六项维度」覆盖 | 0/6 | **6/6** | 维度 → 文件映射表 |
| 真实并发用例 | 0 | **≥4** | 测试清单 |
| 真实幂等用例 | 1（弱） | **≥10** | 测试清单 |
| E2E 链路覆盖 | 1/10（且失败） | **10/10** | spec 清单 |
| 链路门禁墙钟 | 未执行 | **<12 min** | CI 计时 |
| 源码正则断言文件 | 12 | **0** | 静态检查（禁 `readFileSync` 于测试） |

> **沿用既有决策**：覆盖率只作趋势信息，**不作为唯一质量指标**；真实数据流、错误路径与可追溯性优先（`docs/task/0821-03/08-ci-quality-gates-and-operational-verification.md:47`）。

---

## 9. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| RK1 | 环境无法解阻（Docker daemon / 专用 test 库） | 中 | **致命**：P3/P5 全阻塞 | W0 第一步即验证；准备"本机原生 PostgreSQL"备选路径 |
| RK2 | 前端工具链选型反复导致返工 | 中 | 高（+4~6h） | W0 一次性决策并写入 `docs/design/`，其后不得变更 |
| RK3 | 夹具工厂接口未冻结即并行开发 | 高 | 高（返工所有集成/E2E） | A3 串行前置，冻结后 tagged 版本，其他 Agent 只读 |
| RK4 | 共享文件写冲突（package.json 等 5 个热点） | 高 | 中 | 单一 owner + patch 提交；见 §6.6 |
| RK5 | D3 前端权限层被确认为功能开发 | 中 | 高（+8~12h，超范围） | R6 决策前置；若确认，拆为独立迭代 |
| RK6 | 契约测试固化"当前 bug 行为"被误当正确 | 中 | 中 | S12 要求每条护栏测试在名称与注释中标注 `KNOWN_CONTRACT_DEFECT` |
| RK7 | 并发测试在 CI 上不稳定（flaky） | 中 | 中 | 并发用例限定 2-3 次重试；断言"恰好一个成功"而非"哪个成功" |
| RK8 | E2E 反复波动（历史已 1 failed/0 passed） | 高 | 中 | S6 `data-testid` 为强制前置；E2E 排除出 PR 门禁，进 L2 每日门禁 |
| RK9 | Agent 上下文重建导致质量离散 | 中 | 中 | 每个测试文件必须附"生产代码引用 + 断言意图"；评审抽样 10% |
| RK10 | 352 端点契约测试量导致工期膨胀 | 中 | 中 | 按控制器聚合（37 文件）而非按端点逐条；每控制器正向 ≥1 + 鉴权 ×1 + 关键负向 ×1 |

---

## 10. 执行建议顺序（给出决策点）

1. **立即**：解 R1/R2（启动 Docker、建 `dilee_test`），验证 `TEST_DATABASE_URL=<test库> npm run test:integration` 能跑——**这一步决定整个计划是否可执行**。
2. **第 1 天**：W0 + W1（地基 + 夹具冻结），期间确认 R3/R4/R5/R6 四个决策。
3. **第 2 天**：W2-W5 大规模扇出（8 Agent）。
4. **第 3 天**：W6-W8（集成/E2E + 收敛），产出全绿链路门禁报告。
5. **独立立项（不在本计划）**：D1 附件 BigInt 修复、D3 前端权限层、D2 契约违背修正、D7/D8/D9/D10 契约一致性修正、D5/D13 死代码清理。
   → **建议先修 D1**：它是唯一"功能性阻断"缺陷，且修复成本极低（1 行 `BigInt` → `Number` 或加 `toJSON` 补丁）。

---

## 附录 A：本计划可引用的实跑证据

```text
# 后端单元（实跑：415 用例全绿）
npm run test:unit
→ tests 415 / pass 415 / fail 0 / duration_ms 22505（含 api build）
→ 纯测试 7,985 ms

# 前端 lib（实跑：108 用例全绿，但未接线）
cd apps/web && npm run test:unit
→ tests 108 / pass 108 / fail 0 / duration_ms 724

# 链路三层（环境阻断，实测）
npm run test:integration   → TEST_BLOCKED: TEST_DATABASE_URL is required (exit 3)
npm run test:api           → TEST_BLOCKED: API_BASE_URL is required (exit 3)
npm run test:e2e           → TEST_BLOCKED: PLAYWRIGHT_BASE_URL is required (exit 3)

# 环境探针
docker ps                  → failed to connect to dockerDesktopLinuxEngine（daemon 未运行）
Get-Service *postgres*     → 无本地服务；5432 无监听
$env:TEST_DATABASE_URL     → 空
```

## 附录 B：本规划中标记为「未验证」的项

| # | 项 | 建议验证方式 | 归属 |
| --- | --- | --- | --- |
| U1 | D1 附件的精确状态码（500 还是序列化悬挂） | 直接发请求（依赖 R1/R2） | P2 契约 |
| U2 | `P2025`/`P2003` 是否真的落到 500 | 逐个 `PATCH`/`DELETE` 传随机 UUID | P2 契约 |
| U3 | `POST /production-progress/rebuild` 的事务性/幂等 | 读 `production-progress.service.ts` + 实测 | P3 集成 |
| U4 | `production-daily-alerts.service.ts` 的 confirm/resolve | 源码 + 并发实测 | P3 并发 |
| U5 | `purchase-orders.service.ts:40` 到货幂等去重的并发正确性 | 并发同键实测 | P3 并发 |
| U6 | 登录限流在多实例/重启下的行为（进程内 `Map`） | 部署环境实测 | L3 |
| U7 | 是否跨域部署（决定 D11 是否真缺陷） | 产品确认 | 决策 R4 |
| U8 | 前端是否存在调用不存在路由的调用点 | S11 静态差集测试 | P2 契约 |
| U9 | ~~`workbench-adapter.ts` 是否直连后端~~ | **本次已确认**：返回 `demo-data` 常量，非后端调用 | — |
| U10 | 12 个导出端点的 `Content-Disposition` 编码 | 实测响应头 | P2 契约 |
| U11 | `dist` ↔ `src` 一致性（本次跳过 `nest build` 以避免改动文件） | W0 首次门禁自然覆盖 | P0 |
| U12 | 16 个 http/integration 用例在 `c916059` 的实际通过情况 | R1/R2 解除后首跑 | P0 |

---

*本规划基于 `c916059` 工作区的实测与静态审计。所有计数均为实跑或逐文件统计，凡未能证实者已在附录 B 显式标注为「未验证」。*
