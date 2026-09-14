# 前端测试缺口勘察报告（apps/web）

- 勘察对象：`C:\Users\USER\Desktop\Dilee\apps\web`（Next.js App Router + React 19 + TypeScript）
- 勘察方式：静态读取源码 + 实际执行 `npm run test:unit` + 检查 `node_modules` / 配置文件 / CI workflow
- 勘察时间：本轮会话
- 结论摘要：**前端只有「纯函数单测 + 源码文本正则断言」两类测试，完全没有组件/交互测试基础设施。61 个 `.tsx` 中 51 个（83.6%）未被任何测试引用；唯一被引用过的 10 个也只是被正则匹配源码字符串，不验证运行行为。全库无 `useTransition`、无权限门禁、无 403 处理，`disabled=` 仅出现 29 处且多数与防重复提交无关。**

---

## 1. 概览

### 1.1 文件与代码量

统计命令已排除 `node_modules/` 与 `.next/`。

| 区域 | 文件数 | LOC | 说明 |
|---|---|---|---|
| `app/`（路由 + 页面） | 23 | 2556 | 21 个 `page.tsx` + 1 个 `layout.tsx`；另有 `app/workbench.tsx` 被 `app/page.tsx` 转出 |
| `components/`（组件） | 38 | 2025 | ui / data / feedback / layout / modules / panels / production / warehouse / hr |
| `lib/`（业务与工具） | 16 | 433 | 其中 5 个模块无同名 `.test.mjs` |
| 根级（`next.config.ts`、`next-env.d.ts`） | 2 | 25 | — |
| **非测试源码合计** | **79** | **5039** | `.tsx` 61 + `.ts` 18 |
| **已有测试**（`lib/**/*.test.mjs`） | **20** | **1153** | 13 个是「源码文本断言」，7 个是纯函数单测 |
| `tests/e2e/*.spec.mjs`（仓库根，非 apps/web） | 4 | — | 见第 4 节 |

来源：`apps/web` 递归扫描（`*.ts,*.tsx,*.mjs`，排除 `node_modules`/`.next`）。

### 1.2 路由清单（21 条页面路由）

| 路由 | 文件 | LOC |
|---|---|---|
| `/` | `app/page.tsx`（1 行，`export { default } from "./workbench"`） | 1 |
| — | `app/workbench.tsx`（实际工作台实现） | 50 |
| `/login` | `app/login/page.tsx` | 11 |
| `/procurement` | `app/procurement/page.tsx` | 185 |
| `/finance` | `app/finance/page.tsx` | 71 |
| `/finance/salary` | `app/finance/salary/page.tsx` | 198 |
| `/hr` | `app/hr/page.tsx` | 1064 |
| `/hr/departments` | `app/hr/departments/page.tsx` | 2 |
| `/hr/positions` | `app/hr/positions/page.tsx` | 2 |
| `/sales` | `app/sales/page.tsx` | 62 |
| `/customers` | `app/customers/page.tsx`（1 行，转出 `../sales/page`） | 1 |
| `/reports` | `app/reports/page.tsx` | 24 |
| `/production` | `app/production/page.tsx` | 124 |
| `/production/orders/[id]` | `app/production/orders/[id]/page.tsx` | 8 |
| `/production/material-issues` | `app/production/material-issues/page.tsx` | 175 |
| `/production/material-issues/new` | `app/production/material-issues/new/page.tsx` | 15 |
| `/production/locations` | `app/production/locations/page.tsx` | 4 |
| `/production/operations` | `app/production/operations/page.tsx` | 4 |
| `/production/units` | `app/production/units/page.tsx` | 4 |
| `/warehouse` | `app/warehouse/page.tsx` | 72 |
| `/warehouse/raw-material-storage` | `app/warehouse/raw-material-storage/page.tsx` | 202 |
| `/warehouse/finished-goods-storage` | `app/warehouse/finished-goods-storage/page.tsx` | 258 |

**布局文件**：仅 `app/layout.tsx`（1 个，19 行）。无嵌套 layout。

**缺失的 App Router 约定文件**：`loading.tsx` = 0、`error.tsx` = 0、`not-found.tsx` = 0、`template.tsx` = 0、`route.ts` = 0。
→ 所有加载/错误 UI 都是页面内 `useState` 手写（见 5.4 / 5.5），没有框架级 Error Boundary 兜底。

### 1.3 `features/` 目录

**不存在。** `apps/web/features/` 未创建。业务逻辑按「路由页面 + `components/<域>/` + `lib/` 纯函数」三层散落，没有 feature 聚合层。任务书中提到的 `features/` 在本仓库无对应物（已验证）。

### 1.4 `components/` 模块分布

| 子目录 | 文件 | LOC | 文件清单 |
|---|---|---|---|
| `ui/` | 19 | 474 | action-dialog, alert-dialog, badge, button, card, dialog, file-input, form, input, label, multi-checkbox-select, searchable-select, select, separator, sheet, table, textarea, toast, toaster |
| `data/` | 3 | 19 | data-table, filter-bar, status-badge |
| `feedback/` | 1 | 13 | states（EmptyState / LoadingState / ErrorState / DemoNotice） |
| `layout/` | 1 | 50 | app-shell（AppShell / PageHeader） |
| `modules/` | 1 | 11 | module-placeholder（**死代码**，无任何路由引用） |
| `panels/` | 1 | 4 | panels（FormPanel） |
| `production/` | 10 | 1301 | daily-reports-panel(288), material-slip-editor(269), material-issues-panel(194), finished-goods-panel(157), production-order-detail-page(75), unit-pool-page(68), master-data-pool-page(56), outsource-logistics-panel(44), payroll-export-panel(29) |
| `warehouse/` | 1 | 149 | finished-goods-qc-panel |
| `hr/` | 1 | 32 | organization-pool |
| 根级 | 1 | 19 | pwa-register |

### 1.5 `lib/` 模块与同名测试对应表

| lib 模块 | LOC | 同名 `.test.mjs` |
|---|---|---|
| `lib/api-client.ts` | 39 | ✅ `api-client.test.mjs` |
| `lib/auto-open.ts` | 18 | ✅ `auto-open.test.mjs` |
| `lib/collapsible-panel.ts` | 33 | ✅ `collapsible-panel.test.mjs` |
| `lib/download.ts` | 32 | ✅ `download.test.mjs` |
| `lib/format-rate.ts` | 15 | ✅ `format-rate.test.mjs` |
| `lib/material-slip-api.ts` | 28 | ✅ `material-slip-api.test.mjs` |
| `lib/production-candidates.ts` | 60 | ✅ `production-candidates.test.mjs` |
| `lib/refresh-policy.ts` | 6 | ✅（间接，`refresh-policy.test.mjs`） |
| `lib/unit-options.ts` | 37 | ✅ `unit-options.test.mjs` |
| `lib/wms-balances.ts` | 30 | ✅ `wms-balances.test.mjs` |
| `lib/production/daily-report-view.ts` | 92 | ✅ `production/daily-report-view.test.mjs` |
| `lib/adapters/module-adapter.ts` | 2 | ❌ 无 |
| `lib/adapters/workbench-adapter.ts` | 4 | ❌ 无 |
| `lib/demo-data.ts` | 25 | ❌ 无 |
| `lib/display-text.ts` | 7 | ❌ 无 |
| `lib/utils.ts` | 5 | ❌ 无 |

另有 9 个**没有对应 lib 模块**的测试文件，它们直接对 `.tsx` 源码做正则断言：`auto-open-pages.test.mjs`、`daily-reports-panel.test.mjs`、`finance-draft-edit-method.test.mjs`、`finished-goods-storage.test.mjs`、`material-issue-page-actions.test.mjs`、`outbound-notice-entries.test.mjs`、`page-data-alignment.test.mjs`、`production-material-issue-entry.test.mjs`、`warehouse-issue-sheet.test.mjs`。

---

## 2. 数据访问层现状

### 2.1 唯一入口：`apps/web/lib/api-client.ts`（39 行，全文已读）

**类型化响应信封（存在）** — `api-client.ts:1-2`：

```ts
export type ApiSuccess<T> = { data: T; meta: Record<string, unknown> };
export type ApiFailure = { error: { code: string; message: string; details: unknown[] }; meta?: Record<string, unknown> };
```

**错误类型** — `api-client.ts:4-14`：`ApiClientError extends Error`，携带 `code: string` 与 `details: unknown[]`。第 5-6 行有注释说明刻意不用构造函数参数属性，因为 Node 的 strip-only 类型擦除无法解析——这是为了迁就 `.test.mjs` 直接 import `.ts` 而做的妥协。

**GET 调用** — `api-client.ts:16-22`：

```ts
export async function apiGet<T>(path: string): Promise<ApiSuccess<T>> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10000) });
  const body = await response.json().catch(() => null) as ApiSuccess<T> | ApiFailure | null;
  if (!body) throw new ApiClientError(response.status === 401 ? "UNAUTHENTICATED" : "REQUEST_ERROR", `请求失败（HTTP ${response.status}）`);
  if (!response.ok || "error" in body) { const failure = body as ApiFailure; throw new ApiClientError(failure.error.code, failure.error.message, failure.error.details); }
  return body as ApiSuccess<T>;
}
```

**变更调用** — `api-client.ts:24-42`：`apiRequest` 按方法注入超时（GET 不注入、非 GET 注入 `AbortSignal.timeout(60000)`，第 29 行），超时被转换为 `ApiClientError("REQUEST_TIMEOUT", ...)`（第 34 行），JSON 解析失败降级为 `{}`（第 37 行）。导出 `apiPost`（第 41 行）、`apiPatch`（第 42 行）。

**鉴权方式**：
- 使用 **Cookie**（`credentials: "include"`，`api-client.ts:17` 与 `:32`）；
- **不附加任何 Authorization header**。全库无 `Authorization` / `Bearer` / `token` 相关代码；
- 无 CSRF token 注入（未验证 —— 未检查后端是否依赖 SameSite，`未验证`）。

**401 / 403 处理（关键缺口）**：
- `api-client.ts:19` 是**唯一**出现 401 的地方，且只用于「响应体无法解析」这一条分支，把 code 标为 `UNAUTHENTICATED`；
- **全库没有 403 / FORBIDDEN 的任何处理**（`grep '403|FORBIDDEN'` 在 `apps/web` 仅命中 3 处，其中 2 处是注释：`app/procurement/page.tsx:48`、`app/production/material-issues/page.tsx:9`；第 3 处是 `api-client.ts:19` 的 401）；
- 401 → 跳登录的唯一实现是 `components/layout/app-shell.tsx:31-34`：

```ts
apiGet<{...}>("/auth/me").then((result) => { setUser(result.data); setReady(true); }).catch((cause) => {
  if (cause instanceof ApiClientError && ["UNAUTHORIZED", "UNAUTHENTICATED", "AUTH_REQUIRED", "SESSION_EXPIRED"].includes(cause.code)) { window.location.href = "/login"; return; }
  setAuthError(...); setReady(true);
});
```

→ 会话过期只在**挂载 `AppShell` 那一次**判定。页面停留在前台时若 cookie 过期，任何后续请求收到的 401 都**不会**触发跳转，只在页面里显示错误。此逻辑**零测试**。

**错误 / 加载的表示方式**：没有共享抽象。`apiGet` 抛异常，各页面自行 `try/catch/finally` 落到自己的 `useState`。没有 React Query / SWR / 任何缓存层，没有请求去重，没有重试策略。

### 2.2 `lib/adapters/*` —— 适配层是死代码

**`lib/adapters/module-adapter.ts`（全文 2 行）**：

```ts
import { modulePlaceholders } from "../demo-data";
export async function getModulePlaceholder(name: string) { return modulePlaceholders.find(module => module.name === name) ?? null; }
```

**`lib/adapters/workbench-adapter.ts`（全文 5 行）**：

```ts
import { demoOrderProgress, demoProductionProgress, demoReceivablesPayables } from "../demo-data";
export async function getWorkbenchData() {
  return { source: "演示数据" as const, orderProgress: demoOrderProgress, productionProgress: demoProductionProgress, receivablesPayables: demoReceivablesPayables };
}
```

- 两个 adapter **都不发起任何 API 调用**，只返回 `lib/demo-data.ts` 中的演示常量。
- `getModulePlaceholder` 仅被 `components/modules/module-placeholder.tsx:6` 引用，而 `module-placeholder.tsx` **没有任何路由或组件 import 它**（已验证：全库 `grep ModulePlaceholder` 只命中该文件自身）。
- `getWorkbenchData` **没有任何调用方**。工作台真实数据来自 `app/workbench.tsx:37` 的 `apiGet("/order-workbench")` 之类直连。
- 结论：`components/modules/module-placeholder.tsx` + 两个 adapter + `lib/demo-data.ts` 的 `demo*` 数据构成一条**完整的死代码链**，共 4 个文件 0 测试。

因此实际数据流**没有 adapter 层**：`api-client` → 页面 `load()` → `setState` → 渲染。

### 2.3 共享错误 / 加载模式：不存在，每页自己写

每页自建 `loading` / `error` / `message` 三元组。抽样证据：

| 文件 | 行 | 自建状态 |
|---|---|---|
| `app/hr/page.tsx` | 121-124 | `loading, error, message, dialog, categoryDialog` |
| `app/procurement/page.tsx` | 45-49 | `query, selected, dialog, categoryDialog, materialDraft, loading, error, message, materialPanelOpen, supplierPanelOpen, exportBusy` |
| `app/finance/page.tsx` | 25 | 单行声明 15 个 state（11 个列表 + `loading/error/message/dialog/categoryDialog/pendingDialog`） |
| `components/hr/organization-pool.tsx` | 22-24 | `departments, records, loading, error, message, query, status, departmentId, dialog` |

「错误处理」有 **4 种互不相同的写法**，且都是复制粘贴：

1. 页内 `error` state 渲染 `<ErrorState onRetry>`：`app/production/page.tsx:126`、`app/sales/page.tsx:64`、`app/procurement/page.tsx:188`、`components/production/master-data-pool-page.tsx:60`、`components/hr/organization-pool.tsx:34`
2. 页内 `error` 直接渲染 `<p className="status-error">`：`components/production/finished-goods-panel.tsx:143`、`components/warehouse/finished-goods-qc-panel.tsx:151`、`components/production/outsource-logistics-panel.tsx:43`
3. Toast 通知（不占页面位置）：`components/ui/toaster.tsx:9-11` 的 `notify/notifyError/notifySuccess`。`app/finance/page.tsx:31`、`app/hr/page.tsx:164-183`、`app/warehouse/page.tsx:45`、`components/production/material-issues-panel.tsx:150` 走这条
4. 页面完全不做错误 UI，只 `setError("")` 后什么都不显示

同一份「从异常取消息」的逻辑被复制了至少 6 次，写法各不相同：

- `components/hr/organization-pool.tsx:17` — `messageOf = (cause, fallback) => cause instanceof ApiClientError ? cause.message : fallback`
- `app/finance/page.tsx`（`messageOf`）、`app/sales/page.tsx`、`app/procurement/page.tsx`、`app/warehouse/page.tsx`、`app/production/material-issues/page.tsx` 各自本地定义同名函数
- `components/production/daily-reports-panel.tsx` 用 `errorText(cause)`（另一套命名）
- `components/production/production-order-detail-page.tsx:37` 也用 `errorText(cause)`

**重复代码零测试**：这些 `messageOf` / `errorText` 实现没有任何单测，且未从 `lib/` 导出，无法被现有 runner 触达。

---

## 3. 已有前端测试清单

### 3.1 Runner 与执行方式

`apps/web/package.json:9`：

```json
"test:unit": "node --test \"lib/**/*.test.mjs\""
```

- Runner = **Node 内置 `node:test`** + `node:assert/strict`，配合 Node 22 的原生 TypeScript strip-only 类型擦除直接 `import "./x.ts"`。
- **无** vitest / jest / 任何 watch、覆盖率、mock 库。

**实测结果**（本轮实际执行 `npm run test:unit`）：

```
ℹ tests 108
ℹ pass 108
ℹ fail 0
ℹ duration_ms 761.7199
```

并伴随警告：

```
(node:20728) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///.../lib/wms-balances.ts
is not specified and it doesn't parse as CommonJS. Reparsing as ES module ...
```

**根 `package.json` 是否包含 web 单测：不包含。** 根 `package.json` 的 `test` / `test:unit` 只跑 API：

```json
"test": "npm run build --workspace=@dilee/api && node --test apps/api/test/*.test.cjs apps/api/test/unit/**/*.test.cjs",
"test:unit": "npm run build --workspace=@dilee/api && node --test apps/api/test/*.test.cjs apps/api/test/unit/**/*.test.cjs",
```

→ `npm run test:unit`（根）= 只跑 API 测试。`apps/web` 的 108 个测试**必须**手动 `npm -w @dilee/web run test:unit` 才会执行。

### 3.2 逐文件清单（`apps/web/lib/**/*.test.mjs`，20 个）

| 文件 | 类型 | 断言内容 | 是否进 CI |
|---|---|---|---|
| `lib/api-client.test.mjs`（4 用例） | 纯单测 | POST/PATCH 必带超时信号；GET 不注入信号且调用方 signal 优先；TimeoutError → `ApiClientError("REQUEST_TIMEOUT")`；其它网络错误原样抛出 | ❌ |
| `lib/auto-open.test.mjs`（5 用例） | 纯单测 | `shouldAutoOpenDraft` 的五种分支（已打开/未加载/无目标/换目标） | ❌ |
| `lib/download.test.mjs`（3 用例） | 纯单测 | `filenameFromDisposition` 解析 UTF-8 中文名、普通/引号形式、缺失时兜底 | ❌ |
| `lib/material-slip-api.test.mjs`（4 用例） | 纯单测 | 单据类型识别、创建/过账路径、编辑页链接参数 | ❌ |
| `lib/production-candidates.test.mjs`（9 用例） | 纯单测 | 生产单候选筛选、BOM 版本取最大、单位回退 | ❌ |
| `lib/unit-options.test.mjs`（8 用例） | 纯单测 | 单位下拉选项构造、去重、停用单位回显、提交体 null 语义 | ❌ |
| `lib/wms-balances.test.mjs`（4 用例） | 纯单测 | 余额合并、未知物料丢弃、单位名兜底 | ❌ |
| `lib/production/daily-report-view.test.mjs`（12 用例） | 纯单测 | 日报可见性过滤、员工+日期聚合、分钟↔小时换算精度（含与后端 decimal.js 半值进位一致） | ❌ |
| `lib/auto-open-pages.test.mjs`（4 用例） | **源码正则** | 读 `.tsx` 源码断言：effect 依赖数组不包含弹窗自身状态、每个 `useEffect` 都写了依赖数组、采购页对 `/finance/payable-entries` 有 `.catch` 容错 | ❌ |
| `lib/collapsible-panel.test.mjs`（5 用例） | 混合 | 前 4 个纯单测 localStorage 序列化；第 5 个（`:29`）读 `production-order-detail-page.tsx` 正则断言折叠 UI 的 JSX 文案 | ❌ |
| `lib/daily-reports-panel.test.mjs`（5 用例） | **源码正则** | 读 `components/production/daily-reports-panel.tsx` 断言：员工可重复复选、幂等键用 `draft_id` 不用行号、无"分钟"口径、两表有备注列、更正只提交改动字段 | ❌ |
| `lib/finance-draft-edit-method.test.mjs`（3 用例） | **源码正则** | 断言 `finance/page.tsx` 草稿编辑走 PATCH、过账/冲销走 POST | ❌ |
| `lib/finished-goods-storage.test.mjs`（9 用例） | **源码正则** | 断言成品仓储页存在、注册焦点刷新、状态中文映射、次品入口、待入库按剩余量统计、生产单详情挂载面板等 | ❌ |
| `lib/format-rate.test.mjs`（4 用例） | 混合 | 前 3 个纯单测格式化；第 4 个读源码断言完成率都走统一格式化 | ❌ |
| `lib/material-issue-page-actions.test.mjs`（5 用例） | **源码正则** | 断言领料单页有草稿过账/删除按钮、编辑跳转带类型、续开多张、已过账可重开/冲销、过账后发变更事件 | ❌ |
| `lib/outbound-notice-entries.test.mjs`（5 用例） | **源码正则** | 断言销售页/仓库页/财务页存在指定的出库通知按钮与文案 | ❌ |
| `lib/page-data-alignment.test.mjs`（3 用例） | **源码正则（自写解析器）** | 用掩码 + 括号配平解析每个 `Promise.all([...])`，断言绑定名个数与请求数一致、接口顺序与绑定表一致（防"整体错位"） | ❌ |
| `lib/production-material-issue-entry.test.mjs`（5 用例） | **源码正则** | 断言生产单详情挂载领料面板、只有 in_progress 可领料、复用既有接口、先存草稿再过账 | ❌ |
| `lib/refresh-policy.test.mjs`（4 用例） | 混合 | 第 1 个纯单测；第 2/3/4 个读 4 个页面源码断言注册 `focus`/`visibilitychange` 监听并解绑、有"刷新"按钮、`silent` 刷新不切整页 loading | ❌ |
| `lib/warehouse-issue-sheet.test.mjs`（7 用例） | **源码正则** | 断言物料下拉引用 BOM、新建在独立全屏页、列宽样式、回退草稿需填原因、编辑锁生产单、同物料一行、多处续开入口 | ❌ |

### 3.3 这套测试的实质局限（必须写进结论）

1. **13 / 20 是「读源码字符串做正则匹配」**（含 `readFileSync` 的文件：`auto-open-pages`、`collapsible-panel`、`daily-reports-panel`、`finance-draft-edit-method`、`finished-goods-storage`、`format-rate`、`material-issue-page-actions`、`outbound-notice-entries`、`page-data-alignment`、`production-material-issue-entry`、`refresh-policy`、`warehouse-issue-sheet`）。
   → 它们**不渲染组件、不触发事件、不 mock fetch、不断言状态变化**。改写 JSX 文案即会误红，而真正的运行时缺陷（事件未绑定、状态未更新、重复提交）**一律漏过**。
2. **脆弱性（把格式当契约）**：这类断言把 JSX 的**精确书写形式**钉死，任何等价重构都会误红。实例：
   - `refresh-policy.test.mjs:29` 断言 `/onClick=\{\(\) => void load\(\)\}>刷新</` —— 若把处理器改成 `onClick={load}` 或给按钮加一个 prop，行为完全不变但测试失败；
   - `daily-reports-panel.test.mjs:48` 断言 `unitPriceLabel` 的**整个箭头函数体字符串**；`:70` 断言 `const original = emptyEdit(report);\s*\n\s*setEditDialog` 依赖换行位置；
   - `warehouse-issue-sheet.test.mjs:49` 断言关键列的 CSS 类名（纯样式钉死），`:21`/`:76` 断言下拉数据源与入口文案。
   反过来，这些测试**确实**保护了一些真实契约（`daily-reports-panel.test.mjs:29-38` 对"幂等键必须用 `draft_id`、不得用行序号"的断言是有价值的，`:26` 对"草稿行 key 必须带行序号以支持同一员工重复登记"也是对的设计）。因此结论不是"这些测试无用"，而是：**它们只能防止特定字符串被改动，无法发现事件未绑定、状态未更新、重复提交等运行时缺陷。**
3. **零运行时覆盖**：无任何测试执行过 `apiGet`/`apiPost`（`api-client.test.mjs:9-13` 用 `stubFetch` 只验证了 `options.signal`，从未验证 URL 拼接、401 映射、`body.error` 解析路径）。
4. **未进 CI**（见 6.3）。

---

## 4. 已有 E2E 清单

配置：根 `playwright.config.mjs`（`testDir: "./tests/e2e"`，`workers: 1`，`browserName: "chromium"`，`timeout: 60_000`）。

### 4.1 逐 spec 清单

| spec | 覆盖流程 | 步骤数 / 断言数 | 是否稳定可跑 |
|---|---|---|---|
| `tests/e2e/authentication.spec.mjs`（13 行） | ① 匿名访问业务页 → 重定向 `/login` 并显示"登录"标题；② 错误口令 → 显示"用户名或密码错误" | 2 个 test；断言 3 处（`toHaveURL`、`toBeVisible`×2）；交互 3 步（fill×2 + click） | ⚠️ 需 `PLAYWRIGHT_BASE_URL`，否则 `playwright.config.mjs:4-5` 直接抛 `TEST_BLOCKED` |
| `tests/e2e/production-order.spec.mjs`（69 行） | 登录 → 新建生产地点 → 新建工序（选默认单位）→ 新建生产单 → 添加工序 → 启动 | 1 个 test；断言 6 处（`toHaveURL` + `toBeVisible` + `toContainText`×3 + `toContainText` on row）；交互 9 步 | ❌ 见 4.2 |
| `tests/e2e/production-daily-report.spec.mjs`（23 行，含 1 行 8KB 长行） | 登录 → 选订单/工序 → 录员工计时日报 → 查看服务端累计（断言 `over_order`）→ 回工作台看订单推进 | 1 个 test；断言 ~5 处；交互 ~12 步 | ❌ 见 4.2 |
| `tests/e2e/raw-material-movement.spec.mjs`（87 行） | 登录 → 仓库页看影响预览（断言 "8"）→ 创建领料草稿 → 过账 → 退料并过账 → 报废并过账 → 查看/影响 → 冲销门禁（断言"存在后续退料或报废记录，不能冲销来源领料"） | 1 个 test；断言 9 处（`toBeVisible`×4 + `toContainText`×4 + `toBeVisible`）；交互 ~20 步 | ❌ 见 4.2 |

### 4.2 可跑性判定（有证据）

1. **环境硬门禁**：3 个业务 spec 顶部都有
   `if (!databaseUrl || !/test/i.test(databaseUrl)) throw new Error("TEST_BLOCKED: TEST_DATABASE_URL must point to a dedicated test database")`（`production-order.spec.mjs:7`、`production-daily-report.spec.mjs:7`、`raw-material-movement.spec.mjs:7`）；
   `playwright.config.mjs:4-5` 又要求 `PLAYWRIGHT_BASE_URL`；
   `scripts/run-tests.mjs:27-28` 在 e2e 模式下同样检查 `PLAYWRIGHT_BASE_URL`。
   本轮环境中 `PLAYWRIGHT_BASE_URL` 与 `TEST_DATABASE_URL` **均为 UNSET**（已实测）；`.env` 里只有 `POSTGRES_* / INITIAL_ADMIN_* / COOKIE_SECURE / APP_VERSION / DATABASE_URL`，**没有**这两个测试变量。
2. **最近一次真实运行是失败的**：`docs/test/results/playwright-result.json` 的 `stats` 为
   `{"expected":0,"unexpected":1,"flaky":0}`，
   唯一结果 `production.workbench_creates_location_operation_and_starts_an_in_house_order  ok=False`，耗时 70561ms。
   → 仓库里留存的最后一次 E2E 结果 = **1 failed / 0 passed**。
3. **结论**：E2E 套件当前**不可直接复现**（缺环境变量 + 最近记录为失败）。**不要**把它们当作已有的回归保护。这三条 spec 之外，`/hr`、`/finance`、`/sales`、`/reports`、`/procurement`、`/warehouse/*`、成品出库/入库/质检链路**均无 E2E**。

---

## 5. 六大维度覆盖缺口

### 5.1 事件绑定（event binding）

**结论：没有任何测试证明任一 handler 被正确接线。**

现有「测试」只对源码做正则，例如 `material-issue-page-actions.test.mjs:16` 断言 `领料单页面可以对草稿过账出库并删除`，实际做法是 `assert.match(source, /过账出库/)` —— 文案在 JSX 里出现过即通过，**不点击、不渲染**。

用 JSX 中出现的 `<Button`、与测试引用交叉比对（`lib/**/*.test.mjs` 里是否出现该文件路径）：

| 交互密集且**零引用**的组件 | `<Button>` 数 | `disabled=` 数 | 说明 |
|---|---|---|---|
| `components/ui/searchable-select.tsx`（270 行） | 0（裸 `input`/`div`） | 3 | 自绘 combobox：`onKeyDown`（:217）、`onBlur`（:218-220）、`onMouseDown` 阻止默认（:254）、`aria-activedescendant`（:206）全部零覆盖 |
| `components/ui/multi-checkbox-select.tsx`（99 行） | 0（裸 checkbox） | 3（:74,:93 + `optionDisabled`） | `toggle()`（:57-62）"按池顺序输出"的核心契约零覆盖 |
| `components/production/daily-reports-panel.tsx`（288 行） | 10 | 4 | 员工多选复选（:306）、草稿行增删改（:295-299）、行内更正（:303）全部零行为覆盖 |
| `components/production/material-slip-editor.tsx`（269 行） | 6 | 4 | 全屏领料/补料编辑器，所有按钮零覆盖 |
| `components/production/material-issues-panel.tsx`（194 行） | 13 | 9 | 内嵌领料面板，按钮零覆盖 |
| `app/hr/page.tsx`（1064 行） | 10 | **0** | 全站最大页面，**任何测试都没引用过**；导入员工、考勤、绩效、薪资台账、补贴、付款的操作零覆盖 |
| `app/warehouse/finished-goods-storage/page.tsx`（258 行） | 15 | **0** | 登记入库/次品、过账、取消、维护发货、登记签收、冲销、生成出库单 —— 零覆盖 |
| `app/finance/salary/page.tsx`（198 行） | 14 | **0** | 零覆盖 |
| `app/finance/page.tsx`（71 行） | 17 | **0** | 仅被 `finance-draft-edit-method.test.mjs` 正则引用（不验证 handler） |
| `app/warehouse/page.tsx`（72 行） | 16 | **0** | 仅被 `outbound-notice-entries.test.mjs` 等正则引用 |
| `app/warehouse/raw-material-storage/page.tsx`（202 行） | 8 | **0** | 仅被 `refresh-policy.test.mjs` 正则引用 |
| `components/production/production-order-detail-page.tsx`（75 行） | 9 | **0** | 仅被 `collapsible-panel.test.mjs:29` 正则引用 |
| `components/production/outsource-logistics-panel.tsx`（44 行） | 7 | **0** | 完全零引用 |
| `components/production/master-data-pool-page.tsx`（56 行） | 5 | **0** | 完全零引用（工序池/加工地点池的增删改停用恢复） |
| `components/production/unit-pool-page.tsx`（68 行） | 4 | **0** | 完全零引用 |
| `components/warehouse/finished-goods-qc-panel.tsx`（149 行） | 8 | **0** | 完全零引用（成品送检/质检全链路） |
| `components/hr/organization-pool.tsx`（32 行） | 6 | **0** | 完全零引用（部门/岗位池） |
| `components/layout/app-shell.tsx`（50 行） | 2 | **0** | 退出登录按钮（:46）与重试按钮（:39）零覆盖 |
| `components/ui/toaster.tsx`（10 行） | 0 | — | 全局 toast 总线（:8-12）零覆盖 |
| `components/feedback/states.tsx`（13 行） | 1 | **0** | `ErrorState` 的 `onRetry`（:14）零覆盖 |
| `components/data/data-table.tsx`（14 行） | 2 | 2 | 分页按钮（:15）零覆盖 |

**未被任何测试引用的 `.tsx`：51 / 61（83.6%）**。被引用的 10 个是：`app/finance/page.tsx`、`app/procurement/page.tsx`、`app/production/material-issues/page.tsx`、`app/production/page.tsx`、`app/sales/page.tsx`、`app/warehouse/finished-goods-storage/page.tsx`、`app/warehouse/raw-material-storage/page.tsx`、`app/warehouse/page.tsx`、`components/production/material-issues-panel.tsx`、`components/production/production-order-detail-page.tsx` —— 且全部只是被正则字符串匹配。

### 5.2 状态更新（state updates）

**结论：所有本地状态与"乐观更新"全部零行为覆盖。**

全库**没有 `useTransition`**（`grep useTransition` 命中 0 处），没有 `useOptimistic`，没有 reducer。状态全靠 `useState` 散点。`Suspense` 只在 `app/production/material-issues/new/page.tsx:5,17` 用了一次（`fallback={<LoadingState .../>}`），也零覆盖。

**持有本地状态且零覆盖的重点组件**：

| 文件 | 关键状态（行号） | 未测风险 |
|---|---|---|
| `app/hr/page.tsx` | `:117-134` — `attendance, performance, ledgers, payments, loading, error, message, dialog, categoryDialog, employeeQuery, employeeStatus, employeeDepartment, employeePosition, employeeType, importOpen, importResult` | 17 个 state；导入结果 `importResult` 的错误行渲染零覆盖 |
| `app/procurement/page.tsx` | `:45-49` — 含 `materialDraft`、`materialPanelOpen`、`supplierPanelOpen`、`exportBusy` | `materialDraft` 是跨弹窗的草稿透传（`openUnit` :85 回填、`openMaterial` :89 使用），跨弹窗状态机零覆盖 |
| `app/finance/page.tsx` | `:25` — 15 个 state | `pendingDialog` 是"新建供应商后回到采购弹窗"的暂存态（`:38`、`:39`），回填逻辑零覆盖 |
| `app/sales/page.tsx` | `:34` — `dialog, categoryDialog, units, loading, error, message` + `:35-45` `query/selected/customerSelected` | `openOrder(order, preservedValues, newCustomer, newContact)`（`:55`）四级回填（保留表单值→新建客户→新建联系人）零覆盖 |
| `app/reports/page.tsx` | `:19` — `tab, rows, alerts, loading, error, orderNo, pendingAlert` | tab 切换 + `pendingAlert` 二次确认（`:24`）零覆盖 |
| `app/workbench.tsx` | `:36` — `orders, selectedOrder, measurements, selectedOrderNo, filter, loading, error` | 筛选与详情联动零覆盖 |
| `components/production/daily-reports-panel.tsx` | `:41-51` — `drafts, reports, reportEdits, saving, savingReportId, selectedEmployeeIds, inlineReason, selectedReportDate, today` | **最重的编辑态**：`reportEdits` 逐字段 diff（`:252-259` `effectiveReports` 重算行内金额）、`selectedEmployeeIds` 允许多次勾选同一员工不去重 |
| `components/production/material-slip-editor.tsx` | `:49-55` — `loading, busy, error, lines, productionOrderId, editingId, reason` | `changeOrder()` 触发的 `lines` 重算零覆盖 |
| `components/production/material-issues-panel.tsx` | `:41-45` — `busy, error, dialog, draft, preview, lines` | `draft`/`preview` 与 `busy` 的交互零覆盖 |
| `components/production/production-order-detail-page.tsx` | `:32` — 8 个 state | `progress` 合并逻辑（`:37` 把 measurements 与 summaries 拼装）零覆盖 |
| `components/warehouse/finished-goods-qc-panel.tsx` | `:31-35` — 含 `pendingQcValues` | `pendingQcValues`（`:35`）是"先建送检单再回填质检弹窗"的暂存态，`:136` 一次性消费 —— 复杂跨对话框状态机，零覆盖 |
| `components/ui/searchable-select.tsx` | `query, activeIndex, open, placement`（`useState`+`useRef`） | 键盘上下键/回车选择/失焦关闭/向上弹层定位 零覆盖 |
| `components/ui/multi-checkbox-select.tsx` | `:47` `query` | 搜索过滤 + `aria-live` 计数（`:103`）零覆盖 |
| `lib/collapsible-panel.ts` | 纯函数有单测 | 但 `useCollapsiblePanel` hook 的写回 localStorage、跨面板隔离的**运行时**行为零覆盖（`collapsible-panel.test.mjs:8-27` 只测序列化函数） |

**状态"乐观更新"**：本项目**没有真正的乐观更新**。所有变更都是 `await action()` → `await load()` 全量重拉。典型：`app/finance/page.tsx:31`（`await load()`）、`app/hr/page.tsx:169`、`app/procurement/page.tsx:82`、`components/hr/organization-pool.tsx:27`。
唯二的"局部插入"是 `app/finance/page.tsx:38`（`setSuppliers((items) => [...items, result.data])`）与 `app/procurement/page.tsx:85`（`setUnits`）—— 它们**先本地插入再 `load()`**，存在与全量重拉竞态的可能，零覆盖。

### 5.3 API 调用（API invocation）

**结论：组件层 100% 零覆盖。** 没有任何测试渲染组件后断言"点某按钮会发某请求"。

`api-client.test.mjs` 是唯一真实执行 `fetch` 的测试，但它**只断言 `options.signal` 是否存在**（`:22-23`、`:32`、`:35`），不断言 URL、method、body、header、错误映射。因此以下全部未验证：

| 未测行为 | 证据位置 |
|---|---|
| URL 前缀拼接 `/api/v1${path}` | `lib/api-client.ts:17`、`:32` |
| `content-type: application/json` 注入 | `lib/api-client.ts:32` |
| 401 → `UNAUTHENTICATED` code 映射 | `lib/api-client.ts:19`（无测试） |
| 响应体 `{error:{code,message,details}}` → `ApiClientError` | `lib/api-client.ts:20`、`:38`（无测试） |
| `apiPost` / `apiPatch` 的 body 序列化 | `lib/api-client.ts:41-42`（无测试） |
| 导出走裸 `fetch` 而非 `api-client` | `components/production/payroll-export-panel.tsx:25`、`lib/download.ts:19` —— **两套并行的 fetch 实现**，`download.ts` 只测了文件名解析，未测 `downloadFile` 的 18-33 行 |
| 静默容错的 `.catch(() => ({data: []}))` | `app/finance/page.tsx:28`（3 处：`/customers`、`/suppliers`、`/sales-orders`）；`app/procurement/page.tsx:53`（`/finance/payable-entries`）；`components/production/production-order-detail-page.tsx:37`（`/production/operations`、`/units`）。容错本身只有 `auto-open-pages.test.mjs:73` 的**源码正则**保护 |

**未被组件层测试的读接口（按页面）**：

| 页面/组件 | 读接口数 | 证据 |
|---|---|---|
| `app/hr/page.tsx:139-147` | 7（`/production/employees`、`/production/departments`、`/production/positions`、`/hr/attendance-records`、`/hr/performance-records`、`/hr/payroll-ledgers`、`/hr/salary-payments`） | 零覆盖 |
| `app/finance/page.tsx:28` | 11（含 3 个 `.catch` 容错） | 仅源码正则 |
| `app/procurement/page.tsx:53` | 11 | 仅源码正则 |
| `app/warehouse/finished-goods-storage/page.tsx:52-78` | ≥8 | 仅源码正则 |
| `components/production/production-order-detail-page.tsx:37` | 5 | 仅源码正则 |
| `components/production/daily-reports-panel.tsx:54-67` | ≥4 | 仅源码正则 |

**未被组件层测试的写接口（mutation）**：页面通过 `action()` / `run()` / `request()` / `apiPost` 直连，共 4 种不同封装：

| 封装函数 | 位置 | 覆盖写接口举例 | 测试 |
|---|---|---|---|
| `action()` | `app/hr/page.tsx:164` | 员工/考勤/绩效/薪资台账 CRUD | ❌ 零 |
| `action()` | `app/finance/page.tsx:31` | 收款/付款/应付接收/对账（POST+PATCH） | ❌ 仅源码正则断言"走 PATCH" |
| `action()` | `app/procurement/page.tsx:82` | 采购下单/回退/质检状态/通知入库 | ❌ |
| `run()` | `app/warehouse/page.tsx:45`、`app/production/page.tsx:59`、`app/warehouse/raw-material-storage/page.tsx:83`、`app/warehouse/finished-goods-storage/page.tsx:90`、`components/production/production-order-detail-page.tsx:43`、`components/production/unit-pool-page.tsx:42`、`components/production/master-data-pool-page.tsx:43`、`components/production/outsource-logistics-panel.tsx:20`、`components/warehouse/finished-goods-qc-panel.tsx:68`、`app/sales/page.tsx:45`、`app/finance/salary/page.tsx:82` | 仓库过账/冲销/退料/报废、生产单状态流转、成品入库/出库/质检过账 | ❌ |
| `request()` | `components/hr/organization-pool.tsx:27` | 部门/岗位 POST/PATCH/DELETE/restore/active | ❌ 零 |

**同一语义的封装被复制 13 次**，签名都不统一（有的收 `(action: () => Promise)`，有的收 `(path, body, success, method)`），无法共享测试。

### 5.4 加载态（loading states）

**现状**：无 `loading.tsx`（0 个），加载 UI 全部是页面内 `loading` state 条件渲染。

| 加载 UI | 位置 | 测试 |
|---|---|---|
| `<LoadingState />` 整页替换 | `components/production/master-data-pool-page.tsx:60`、`unit-pool-page.tsx:73`、`app/production/page.tsx:126`、`app/production/material-issues/page.tsx:160` | ❌ 零行为覆盖 |
| 带文案的整页 loading | `app/warehouse/raw-material-storage/page.tsx:173`、`app/warehouse/finished-goods-storage/page.tsx:227`、`components/production/production-order-detail-page.tsx:75` | ❌ |
| `AppShell` 的"正在验证登录状态..." | `components/layout/app-shell.tsx:38` | ❌ |
| 按钮内联 loading 文案 | "登录中"`app/login/page.tsx:11`；"导出中..."`app/procurement/page.tsx:170`、`app/production/material-issues/page.tsx:157,167`；"保存中..."`components/production/daily-reports-panel.tsx:297`、`material-issues-panel.tsx:197`、`material-slip-editor.tsx:215`；"过账中..."`material-issues-panel.tsx:198`；"提交中..."`material-slip-editor.tsx:216` | ❌ 全零覆盖 |
| `<Suspense fallback={<LoadingState label="正在加载单据编辑页" />}>` | `app/production/material-issues/new/page.tsx:17` | ❌ 唯一 Suspense，零覆盖 |
| `SearchableSelect` 的空结果提示（`role="status"`） | `components/ui/searchable-select.tsx:225-227` | ❌ |
| `MultiCheckboxSelect` 的"无匹配项"（`role="status"`） | `components/ui/multi-checkbox-select.tsx:82` | ❌ |
| `DataTable` 的 `loading` prop → `<LoadingState />` | `components/data/data-table.tsx:10,12` | ❌ data-table 完全未被引用 |
| `finished-goods-qc-panel` 的 `detailLoading` 文案 | `components/warehouse/finished-goods-qc-panel.tsx:153`（"正在加载订单质检详情…"） | ❌ |

**关键未测语义**：`refresh-policy.test.mjs:43-55` 才用**源码正则**保护了"后台 silent 刷新不能切整页 loading"这条真实用户反馈驱动的需求（`app/procurement/page.tsx:53`、`app/warehouse/raw-material-storage/page.tsx:41`、`app/warehouse/finished-goods-storage/page.tsx:52`、`components/production/production-order-detail-page.tsx:37`）。**没有任何测试真的模拟"切走再切回"**，无法证明弹窗内容不被清空。

### 5.5 错误态（error states）

**现状**：无 `error.tsx`（0 个 Error Boundary），错误 UI 全靠页面内 `error` state 手写，4 种风格并存（见 2.3）。

| 错误 UI | 位置 | 测试 |
|---|---|---|
| `<ErrorState message onRetry>` | `app/production/page.tsx:126`、`app/sales/page.tsx:64`、`app/procurement/page.tsx:188`、`components/production/master-data-pool-page.tsx:60`、`components/hr/organization-pool.tsx:34` | ❌ 无测试点击过 `onRetry` |
| `ErrorState` 组件自身 | `components/feedback/states.tsx:13-15`（含 `onRetry` 按钮 `:14`） | ❌ 完全未被任何测试引用 |
| `<p className="status-error" role="alert">` | `components/production/finished-goods-panel.tsx:143`、`components/warehouse/finished-goods-qc-panel.tsx:151`、`components/production/payroll-export-panel.tsx:31` | ❌ |
| `<section className="panel panel-body status-error" role="alert">` | `app/production/material-issues/page.tsx`、`components/production/material-slip-editor.tsx:218` | ❌ |
| `<section className="panel panel-body status-danger" role="alert">` | `app/workbench.tsx:50` | ❌ |
| Toast 错误通知 | `components/ui/toaster.tsx:10`（`notifyError`），由 `app/finance/page.tsx:31`、`app/hr/page.tsx:171`、`app/warehouse/page.tsx:45` 等调用 | ❌ toaster 完全零覆盖 |
| `app-shell` 的鉴权失败态 + 重试按钮 | `components/layout/app-shell.tsx:39` | ❌ |
| `ActionDialog` 内的校验/提交错误 | `components/ui/action-dialog.tsx:17,28`（`validationError`） | ❌ |
| 空数据 `<EmptyState>` | `components/feedback/states.tsx:5-7`；被 `app/production/page.tsx:127`、`app/sales/page.tsx:64`×2、`app/warehouse/page.tsx:75`×3、`app/procurement/page.tsx:188`、`organization-pool.tsx:34`、`finished-goods-qc-panel.tsx:153`×3、`app/workbench.tsx:52`、`outsource-logistics-panel.tsx:43`×2 等使用 | ❌ 零覆盖 |
| 校验错误分支（必填/数字范围） | `components/ui/action-dialog.tsx:28`（`missing` 判定）；`app/procurement/page.tsx:113`（6 个分支）；`components/production/daily-reports-panel.tsx:215-232`（4 个分支） | ❌ 全部零覆盖 |

**最危险的未测错误路径**：`ActionDialog` 的 `catch`（`action-dialog.tsx:28` 末尾 `catch (cause) { setValidationError(...) }`）—— 提交失败时弹窗**保持打开**并显示错误，这是"提交失败后能否重试"的核心交互，零覆盖。

### 5.6 权限（permissions）

**结论：前端根本没有权限层。机制是"后端拒绝 + 前端静默降级"，且这条链路零测试、无 403 处理。**

**机制调研（穷尽搜索 `permission|role|Module|权限|can[A-Z]|hasAccess|forbidden|403`）**：

| 发现 | 位置 | 性质 |
|---|---|---|
| 唯一鉴权门禁 | `components/layout/app-shell.tsx:28-35` | 挂载时 `apiGet("/auth/me")`；失败且 code ∈ `["UNAUTHORIZED","UNAUTHENTICATED","AUTH_REQUIRED","SESSION_EXPIRED"]` 才 `window.location.href = "/login"`（`:32`） |
| 导航菜单**静态硬编码** | `components/layout/app-shell.tsx:12-21` | 8 个模块（工作台/生产/采购/财务/仓库/人事/客户与销售/报表）**对任何登录用户全量渲染**，没有任何按角色/模块过滤 |
| **无** `role` / `permission` / `can*` 判定 | 全库 | `grep role` 只命中 `role="status"`、`role="alert"`、`role="combobox"`、`role="listbox"`、`role="option"`、`role="group"`、`role="search"`、`role="row"` 等 ARIA 属性（如 `searchable-select.tsx:201,238,249`、`multi-checkbox-select.tsx:80`、`filter-bar.tsx:3`） |
| 权限只靠**注释**说明由后端兜底 | `app/finance/page.tsx:26`「客户/销售单选项走的是 sales 模块权限：只有财务权限的账号拉不到它们」；`app/production/material-issues/page.tsx:9`「仅管理员可用（非管理员会收到后端 403 提示）」；`app/procurement/page.tsx:48`（同类注释） | 前端**不**预先隐藏无权限入口 |
| **无 403 / FORBIDDEN 处理** | 全库 | 403 落到 `api-client.ts:38` 的通用分支，变成带后端 code 的 `ApiClientError`，**没有任何页面按 `FORBIDDEN` 分支渲染** |
| 401 只在挂载时判定一次 | `components/layout/app-shell.tsx:31-34` | 会话在前台过期后，后续 401 **不会**跳登录 |
| 无权限时**静默降级为空列表** | `app/finance/page.tsx:28`（`/customers`、`/suppliers`、`/sales-orders` 三处 `.catch(() => ({ data: [] }))`）；`app/procurement/page.tsx:53`（`/finance/payable-entries`）；`components/production/production-order-detail-page.tsx:37`（`/production/operations`、`/units`） | 403 与"真的没数据"在 UI 上**无法区分** |

**已受保护的相关测试**：`auto-open-pages.test.mjs:73` 用**源码正则**断言「采购页对财务应付台账的读取必须容错」—— 保护的是"别整页白屏"，**不保护**"403 要给出可理解的提示"。

**需要覆盖但零覆盖的权限相关文件**：
- `components/layout/app-shell.tsx:28-39`（鉴权门禁 + 401 跳转 + 失败重试）— 零覆盖
- `lib/api-client.ts:19-20,38`（401/403 映射）— 零覆盖
- `app/finance/page.tsx:26-28`（销售模块权限缺失时的空下拉降级）— 零覆盖
- `app/production/material-issues/page.tsx:9`（管理员专属导出，非管理员吃 403）— 零覆盖
- `app/procurement/page.tsx:48`（管理员专属导出）— 零覆盖

### 5.7 防重复提交（duplicate-submit prevention）

#### 5.7.1 全库实测统计

| 指标 | 数量 | 证据 |
|---|---|---|
| `useTransition` / `isPending` | **0** | 全库 grep 无命中 |
| 出现 `disabled` 的位置 | **29** | `grep disabled=\{` 全库计数 |
| 其中**真正**的防重复提交守卫 | **约 12** | 见 5.7.2 |
| 其余 `disabled` | 17 | 均为业务条件禁用（如 `disabled={!canNotice}`、`disabled={row.wage_mode === "piece_rate"}`、`disabled={!table.getCanPreviousPage()}`），**不防重复提交** |
| 有 `<Button>` 但 `disabled=` 数为 **0** 的文件 | **15** | 见 5.7.3 |

#### 5.7.2 已有守卫（存在但基本未测）

| # | 位置 | 守卫实现 | 覆盖情况 |
|---|---|---|---|
| 1 | `components/ui/action-dialog.tsx:18` | `const [submitting, setSubmitting] = useState(false)`；`:28` `submit()` 中 `setSubmitting(true)` → `try { await onSubmit(values) } finally { setSubmitting(false) }`；`:29` `addCategory()` 同样；`:30` 所有输入 `disabled={submitting}`、`<Dialog onOpenChange={(next) => { if (!submitting) onOpenChange(next) }}>` **且弹窗关闭也被门禁**；提交按钮 `disabled={submitting}` | ❌ **零测试**。这是全站唯一"强守卫"，但没有任何测试验证它 |
| 2 | `components/production/daily-reports-panel.tsx:46` + `:214` | `const [saving, setSaving] = useState(false)`；`save()` 第 2 行 `if (saving) return;`（**真正的重入锁**）；`:234` set true，`:248` `finally` set false；`:297` 按钮 `disabled={saving}` | ⚠️ `daily-reports-panel.test.mjs` 只正则断言幂等键文案，**未测** `if (saving) return` 与 `disabled={saving}` |
| 3 | `components/production/daily-reports-panel.tsx:51` | `savingReportId: string \| null`（**按行**锁）；`:141` set、`:173` clear；`:303` 按钮 `disabled={!reportEditDirty(report) \|\| savingReportId === report.id}` | ⚠️ 同上，未测 |
| 4 | `components/production/material-issues-panel.tsx:41` | `const [busy, setBusy] = useState("")` 作为**多路互斥锁**：`"save"`(`:119,121`)、`"post"`(`:126,134`)、`movement.id`(`:137,140` 与 `:143,146`)、`"action"`(`:151,154`)；`:165-166` 行内按钮 `disabled={busy === movement.id}` / `disabled={busy === "action"}`；`:197-198` `disabled={busy === "save"}` / `disabled={busy === "post"}` | ⚠️ `production-material-issue-entry.test.mjs`、`warehouse-issue-sheet.test.mjs` 只正则断言"先保存草稿再过账"，**未测**锁本身 |
| 5 | `components/production/material-slip-editor.tsx:50` | `busy: boolean`；`:181` `setBusy(true)`，`:200` `finally`；`:215-216` 两个提交按钮 `disabled={busy}` | ❌ 完全零覆盖（该文件未被任何测试引用） |
| 6 | `app/production/material-issues/page.tsx:60` | `busy: string`；`:66,69`、`:72,75`、`:80,83`、`:134,138`、`:142,145`；`:157` `disabled={busyRow}`（导出/过账/删除）、`disabled={busy === "action"}`（重开/冲销）；`:167` `disabled={busy === "all" \|\| !visible.length}`（批量导出） | ⚠️ `material-issue-page-actions.test.mjs` 仅正则断言按钮存在 |
| 7 | `app/procurement/page.tsx:49` | `exportBusy: string`；`:65,68`、`:72,80`；`:170` `disabled={exportBusy === row.original.id}`；`:188` `disabled={exportBusy === "all"}` | ⚠️ 仅正则 |
| 8 | `components/production/payroll-export-panel.tsx:19` | `busy: boolean`；`:24` set true；导出按钮 `disabled={busy}`、取消按钮 `disabled={busy}`，且 4 个 Dialog 的 `onOpenChange` 都加了 `if (!value && !busy)` 门禁（`:31`） | ❌ 完全零覆盖 |
| 9 | `app/login/page.tsx:9` | `loading: boolean`；`:10` `setLoading(true)` → `finally setLoading(false)`；`:11` `<Button type="submit" disabled={loading}>` | ⚠️ E2E `authentication.spec.mjs:13` 点了登录按钮，但**未断言**按钮在请求期间 disabled，也未测双击 |
| 10 | `components/data/data-table.tsx:15` | 分页 `disabled={!table.getCanPreviousPage()}` / `disabled={!table.getCanNextPage()}` | 业务条件，非提交守卫；且该文件零覆盖 |
| 11 | `components/production/material-issues-panel.tsx:174` | `disabled={!issuable \|\| Boolean(draft) \|\| !materialOptions.length}` | 业务条件（有草稿时禁用新建），非提交守卫 |
| 12 | `components/production/material-slip-editor.tsx:226` | `disabled={Boolean(editingId)}`（编辑时锁生产单） | 业务条件 |

#### 5.7.3 有按钮但**零** `disabled` 的文件（防重复提交完全缺失）

以下 18 个文件共渲染 **153 个 `<Button>`**（逐文件 `[regex]::Matches` 计数求和），其中 **`disabled=` 计数为 0 或仅为业务条件**，因此按钮在请求进行中普遍可被重复点击。且它们调用的 `run()`/`action()`/`request()` 封装**内部没有 in-flight 标志**（已逐个读过函数体）：

| 文件 | `<Button>` 数 | `disabled=` | 关键可重复提交入口（file:line） |
|---|---|---|---|
| `app/hr/page.tsx` | 10 | **0** | `action()` `:164`（员工/考勤/绩效/薪资台账写操作）、`runPatch()` `:174`、`openDepartment()` `:216`、`openPosition()` `:272`、`openEmployeeType()` `:340`。注意 `:164-183` 两个函数体**没有**任何 `busy` 变量 |
| `app/finance/page.tsx` | 17 | **0** | `action()` `:31`；`:56` `onClick={() => receivePayableSource(row.original)}`「接收应付」；`:60-61` 收款/付款确认按钮 |
| `app/finance/salary/page.tsx` | 14 | **0** | `run()` `:82`（薪资台账生成/确认/付款，全部可重复点） |
| `app/warehouse/page.tsx` | 16 | **0** | `run()` `:45`；`:70` 「补建入库草稿」、`:71` 「接收入库通知」、`:72` 过账/删除/回退草稿/冲销/审计、`:75` 退料/报废 |
| `app/warehouse/finished-goods-storage/page.tsx` | 15 | **0** | `run()` `:90`；`:183` 登记入库/登记次品、`:191` 过账/冲销、`:203` 过账出库/取消出库单/维护发货/登记签收/冲销、`:213` 生成出库单、`:221` 次品过账/冲销 |
| `app/warehouse/raw-material-storage/page.tsx` | 8 | **0** | `run()` `:83`；`:151` 编辑、`:152` 过账、`:153` 删除、`:155` 冲销 |
| `app/sales/page.tsx` | 16 | 2（业务条件） | `run()` `:45`；`:60` 确认/回到草稿/编辑、`:61` 停用/启用/删除客户 |
| `app/production/page.tsx` | 7 | **0** | `run()` `:59`；`:118` 「启动」生产单、`:122` 新建生产单 |
| `app/reports/page.tsx` | 7 | **0** | `:24` 告警「确认」/「解决」按钮（`setPendingAlert` → 二次确认后提交），零守卫 |
| `components/hr/organization-pool.tsx` | 6 | **0** | `request()` `:27`（无 busy 变量）；`:32` 「恢复」/「启用/停用」/「删除」三个行内按钮 —— **重复点击会发出重复 DELETE / 重复状态翻转** |
| `components/production/master-data-pool-page.tsx` | 5 | **0** | `run()` `:43`；`:58` 恢复/编辑/停用/删除 |
| `components/production/unit-pool-page.tsx` | 4 | **0** | `run()` `:42`；单位池增删改 |
| `components/production/outsource-logistics-panel.tsx` | 7 | **0** | `run()` `:20`；`:41` 「直发」/「签收」/「删除草稿」、`:43` 新建批次/余料回厂/成品回厂/直装柜 |
| `components/warehouse/finished-goods-qc-panel.tsx` | 8 | **0** | `run()` `:68`；`:143` 「创建送检」、`:144` 「编辑」/「提交送检」、`:150` 「录入质检」/「刷新」、`:153` 「为此订单录入质检」 |
| `components/production/production-order-detail-page.tsx` | 9 | **0** | `run()` `:43`；`:56` 状态流转、`:57` 添加工序、`:45` 编辑工序、折叠切换 |
| `components/layout/app-shell.tsx` | 2 | **0** | `:36` `logout()`（`apiPost("/auth/logout")` 后跳转）—— **连点会发多次登出请求**；`:39` 重试 |
| `components/feedback/states.tsx` | 1 | **0** | `:14` `onRetry` —— 重试风暴风险 |
| `components/modules/module-placeholder.tsx` | 1 | **0** | 死代码 |

> `guardTokens` 类统计存在**假阳性**：例如 `app/warehouse/raw-material-storage/page.tsx` 命中 6 次 `pending` 全部来自列名（`:131` `id: "pending"`、`:133`、`:163` `pendingByKey`），`app/finance/page.tsx` 命中 14 次来自 `pendingReceivables`（`:34-35`）与 `pendingDialog`，**都不是**提交守卫。本节的结论按逐个函数体人工确认，未依赖该统计。

### 5.8 数据流（data flow）

**真实链路（无 adapter 层）**：

```
lib/api-client.ts apiGet/apiPost/apiPatch
        │  fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store", signal })
        ▼
页面/面板的本地 load()： await Promise.all([apiGet(...), apiGet(...), ...])
        │  （用解构数组接收，绑定顺序即接口顺序 —— 曾发生整体错位事故，见 page-data-alignment.test.mjs:3-7 注释）
        ▼
多个 setXxx(result.data)   ← 每个接口一个 setState，无事务性
        ▼
useMemo 派生（筛选 / 汇总 / 格式化）
        ▼
<DataTable columns data empty> → @tanstack/react-table → flexRender（components/data/data-table.tsx:15）
<ActionDialog> / <Sheet> / <Dialog> → 表单与详情
        ▼
lib/display-text.ts displayText/displayStatus（data-table.tsx:14、status-badge.tsx:4、reports/page.tsx:25）
```

**未测节点逐项**：

| 数据流节点 | 位置 | 覆盖 |
|---|---|---|
| `apiGet` → 信封解包 → `result.data` | `lib/api-client.ts:16-22`；全站 100+ 处调用点 | ❌ 组件层零覆盖；`api-client.test.mjs` 只测 `signal` |
| `Promise.all` 解构顺序与接口顺序对齐 | `app/finance/page.tsx:28`（11 个）、`app/procurement/page.tsx:53`（11 个）、`app/hr/page.tsx:139-147`（7 个）、`app/warehouse/page.tsx:43`（5 个）、`app/sales/page.tsx:37`（3 个）、`components/production/production-order-detail-page.tsx:37` | ⚠️ 仅 `page-data-alignment.test.mjs` 的**自写源码解析器**（`:52-60` 掩码+括号配平）保护，无运行时验证 |
| 一个接口失败整页失败的边界 | `app/finance/page.tsx:28`、`app/procurement/page.tsx:53` 靠 `.catch` 局部容错 | ❌ 容错行为未运行时验证 |
| 静默刷新不卸载正在编辑的弹窗 | `refresh-policy.ts` + 4 个页面的 `load({silent:true})`（`app/procurement/page.tsx:50-53`、`app/warehouse/raw-material-storage/page.tsx:40-43`、`app/warehouse/finished-goods-storage/page.tsx:50-52`、`components/production/production-order-detail-page.tsx:35-37`） | ⚠️ 仅 `refresh-policy.test.mjs:43-55` 源码正则 |
| 跨页面刷新事件总线 | `components/production/daily-reports-panel.tsx:72`（监听 `production-order-operation-updated`）、`components/production/finished-goods-panel.tsx:61-63`（`focus` + `visibilitychange` + `production-order-operation-updated`）、`components/production/production-order-detail-page.tsx:43`（`notifyOperationChanged()`） | ❌ 事件发布/订阅的运行时行为零覆盖 |
| `DataTable` 渲染与 `displayText` 转换 | `components/data/data-table.tsx:14-15`；`lib/display-text.ts:6-8`（**无测试**） | ❌ data-table 与 display-text 均完全未被引用 |
| `useMemo` 派生筛选/汇总 | `components/hr/organization-pool.tsx:31`、`app/sales/page.tsx`（`visibleOrders`）、`app/procurement/page.tsx`、`components/production/daily-reports-panel.tsx:252-259`（`effectiveReports` 重算金额） | ❌ 除 `daily-report-view.test.mjs` 覆盖了其中的纯函数外，组件内 `useMemo` 零覆盖 |
| 死链：`components/modules/module-placeholder.tsx` → `lib/adapters/*` → `lib/demo-data.ts` | `module-placeholder.tsx:6,9`；`module-adapter.ts:3`；`workbench-adapter.ts:3-5` | ❌ 4 个文件 0 测试。`getWorkbenchData` **无任何调用方** |

---

## 6. 缺失的测试工具链

### 6.1 包缺失（实测：在根 `node_modules` 与 `apps/web/node_modules` 两处都查找）

| 包 | 状态 | 用途 |
|---|---|---|
| `@testing-library/react` | **ABSENT** | 组件渲染与交互 |
| `@testing-library/dom` | **ABSENT** | 同上 |
| `@testing-library/user-event` | **ABSENT** | 真实事件模拟（点击/输入/键盘） |
| `@testing-library/jest-dom` | **ABSENT** | DOM 断言匹配器 |
| `jsdom` | **ABSENT** | DOM 环境 |
| `happy-dom` | **ABSENT** | DOM 环境替代 |
| `vitest` | **ABSENT** | 组件测试 runner |
| `jest` | **ABSENT** | 组件测试 runner |
| `msw` | **ABSENT** | 网络层 mock |
| `@vitejs/plugin-react` | **ABSENT** | 组件测试编译 |
| `@playwright/test` | **ABSENT** | 注意：根 `package.json` devDependencies 里是 `"playwright": "^1.62.1"`（**不是** `@playwright/test`）；`playwright.config.mjs:1` 从 `"playwright/test"` 导入 |
| `c8` / `nyc` / `@vitest/coverage-v8` | **ABSENT** | 覆盖率统计（因此**没有前端覆盖率数字可汇报**） |
| `playwright` | INSTALLED（根 `node_modules`） | E2E |
| `tsx` / `esbuild` | INSTALLED（根 `node_modules`，作为传递依赖） | 未配置为测试用途 |

`apps/web/package.json`（36 行，全文已读）：
- `devDependencies` 只有 4 项：`@types/node`、`@types/react`、`@types/react-dom`、`typescript`（`:30-35`）；
- `scripts` 只有 5 项：`dev`、`build`、`typecheck`、`test:unit`、`lint`（`:5-11`）；
- **没有** `test`、`test:coverage`、`test:component` 之类的脚本。

### 6.2 配置文件缺失（逐个 `Test-Path` 实测）

| 文件 | 状态 |
|---|---|
| `vitest.config.ts` / `.mts` / `.js` / `.mjs` | **ABSENT**（4 个变体全部不存在） |
| `jest.config.js` / `.ts` / `.mjs` / `.cjs` | **ABSENT**（4 个变体全部不存在） |
| `apps/web/vitest.config.ts` | **ABSENT** |
| `apps/web/jest.config.js` | **ABSENT** |
| `playwright.config.mjs`（仓库根） | ✅ 存在 |
| `apps/web/playwright.config.ts` | **ABSENT** |
| `apps/web/tsconfig.json` | ✅ 存在（仅用于 `typecheck`） |
| `apps/web/next.config.ts` | ✅ 存在（22 行；含 `/api/v1/*` rewrite 到 `API_INTERNAL_URL`，`:10-12`） |
| setup 文件（`setupTests.ts` / `test-setup.ts`） | **ABSENT** |
| CI 中的测试 job | **ABSENT**（见 6.3） |

`apps/web` 下**没有** `__tests__/`、`*.test.tsx`、`*.spec.tsx`、`*.test.ts`（组件/交互测试文件数为 **0**）。

### 6.3 CI 是否调用这些测试 —— 实测：**不调用**

`.github/workflows/deploy.yml`（全仓库**唯一** workflow；`.github/workflows/` 下只有这一个文件）的 `verify` job：

```yaml
      - run: npm ci
      - run: npx prisma generate --schema apps/api/prisma/schema.prisma
      - run: npm run typecheck
      - run: npm run build --workspace=@dilee/api
      - run: npm run build --workspace=@dilee/web
```

- **没有** `npm test`、`npm run test:unit`、`npm test:e2e`、`npm run test:api` 中的任何一条；
- 触发条件仅 `push: branches: [main]` 与 `workflow_dispatch`（**PR 不触发**）；
- → 结论：**`apps/web` 的 108 个 lib 测试、4 个 E2E spec 全部不在 CI 中执行**。CI 只做 `typecheck` + `build`，而 TypeScript 无法捕获本报告列出的任何一类缺陷（事件未绑定、状态未更新、重复提交、权限未处理、API 参数错误）。

根 `package.json` 中虽有 `test:e2e`、`test:api`、`test:integration`，但它们是本地脚本，未被 workflow 引用。

---

## 7. 高优先级补测清单（Top 15）

排序依据：可被自动化测试捕获的缺陷严重度 × 该代码路径的业务重要性 × 当前零覆盖程度。

| # | 文件（路径） | 一行理由 | 建议测试手段 |
|---|---|---|---|
| 1 | `apps/web/components/ui/action-dialog.tsx:18,28,30` | 全站**唯一**的强防重复提交守卫（`submitting` 门禁输入、按钮、弹窗关闭），却零测试；它一回归就是全站表单重复提交 | 组件测试：mock 挂起 Promise，双击提交按钮断言 `onSubmit` 只调用一次；断言关闭被门禁 |
| 2 | `apps/web/lib/api-client.ts:16-42` | 全站 100+ 处调用的唯一出口；`api-client.test.mjs` 只断言 `signal`，**未验证 URL 拼接、401 映射、`{error:{code,message,details}}` 解析、`apiPost/apiPatch` 序列化** | 纯单测扩展（无需 DOM），复用现有 `stubFetch` 模式 |
| 3 | `apps/web/components/layout/app-shell.tsx:28-39` | 唯一鉴权门禁 + 401 跳登录 + 失败重试的完整实现，零覆盖；且会话前台过期后不再跳转（潜在缺陷） | 组件测试：mock `apiGet` 返回各 code，断言 `window.location.href` 与错误态渲染 |
| 4 | `apps/web/app/hr/page.tsx:164,174`（+ `:117-134` 17 个 state） | 全站最大页面（1064 行）、10 个按钮、**0 个 `disabled`**、`action()` 无 in-flight 标志 —— 全部 HR 写操作可重复提交且无任何测试引用 | 先补 `busy` 守卫，再补组件测试断言按钮在请求中禁用 |
| 5 | `apps/web/components/hr/organization-pool.tsx:27,32` | `request()` 无 `busy`；「删除」「启用/停用」「恢复」三个行内按钮无 `disabled` → 连点发出重复 DELETE / 重复状态翻转 | 组件测试：双击删除断言只调一次 `apiRequest` |
| 6 | `apps/web/components/production/daily-reports-panel.tsx:214,234,248,297,303` | 薪资相关的**最重编辑态**（`drafts`/`reportEdits`/`savingReportId`），有真实的 `if (saving) return` 重入锁却只被源码正则覆盖；同时 `:299` 行 key 含 `index`（潜在错位缺陷） | 组件测试：断言重入锁、`disabled`、行内金额重算、`reportEdits` diff 提交 |
| 7 | `apps/web/app/finance/page.tsx:28,31,56` | 11 个并行接口 + 3 处静默 `.catch` 容错 + 17 个按钮 0 个 `disabled`；财务写操作重复提交后果最严重 | 组件测试：断言 `.catch` 降级后 UI 仍可用、接收应付按钮幂等 |
| 8 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:90,183,191,203,213,221` | 成品入库/出库/质检/次品/发货/签收/冲销全链路，15 个按钮 0 个 `disabled`，仅被源码正则覆盖 | 组件测试 + 补充 E2E（当前无任何成品链路 E2E） |
| 9 | `apps/web/components/warehouse/finished-goods-qc-panel.tsx:35,68,143,144` | 成品送检/质检核心域，`pendingQcValues` 跨对话框状态机（`:35` 写、`:136` 消费）+ 8 个按钮 0 个 `disabled`，**完全零引用** | 组件测试覆盖"先建送检单再回填质检弹窗"状态机 |
| 10 | `apps/web/app/procurement/page.tsx:50-53,82,113,170` | 11 个并行接口 + `silent` 刷新（用户反馈驱动）+ 6 个校验分支 + `action()` 无 `busy`；仅源码正则 | 组件测试：`silent` 刷新不清空弹窗输入、校验分支渲染、下单幂等 |
| 11 | `apps/web/components/production/material-issues-panel.tsx:41,118-154,197-198` | 多路互斥锁 `busy`（`"save"`/`"post"`/`id`/`"action"`）是全站最完善的局部守卫设计，但零行为测试；配合"先存草稿再过账"的幂等契约 | 组件测试：断言各 `busy` 取值下按钮禁用矩阵 |
| 12 | `apps/web/components/ui/searchable-select.tsx:195-287`（270 行） | 自绘 combobox，键盘导航（`onKeyDown` :217）、失焦关闭（:218）上下弹层定位（`placement`）全部零覆盖；被 `ActionDialog` 的 `searchable-select` 字段类型广泛复用 | 组件测试：键盘上下键/回车/失焦/Esc |
| 13 | `apps/web/components/ui/multi-checkbox-select.tsx:57-62` | `toggle()` 的"按池顺序输出"是提交确定性的核心契约；`:103` `aria-live` 计数；零覆盖 | 纯/组件测试（逻辑可先抽为纯函数） |
| 14 | `apps/web/components/feedback/states.tsx:5-15` + `apps/web/components/data/data-table.tsx:10-15` | 全站加载/空/错误三态与表格分页的**唯一共享组件**，`onRetry` 与分页边界全部零覆盖；改坏它们会全站退化 | 组件测试：`EmptyState`/`LoadingState`/`ErrorState`/分页边界 |
| 15 | `apps/web/app/warehouse/page.tsx:45,70-75`、`apps/web/components/production/production-order-detail-page.tsx:43,56`、`apps/web/components/production/master-data-pool-page.tsx:43,58`、`apps/web/components/production/outsource-logistics-panel.tsx:20,41`、`apps/web/components/production/unit-pool-page.tsx:42`、`apps/web/app/warehouse/raw-material-storage/page.tsx:83`、`apps/web/app/finance/salary/page.tsx:82`、`apps/web/app/production/page.tsx:59`、`apps/web/app/sales/page.tsx:45` | 13 个 `run()`/`action()` 封装全部无 in-flight 标志（签名还各不相同），覆盖仓库过账/冲销/退料/报废、生产单流转、工序池、单位池、外加工交接、薪资 —— 合并为一项"抽取统一 `useMutation` 守卫 + 测试" | 抽 `lib/use-mutation.ts` 纯逻辑 + 组件测试 |

### 7.1 工具链落地的最小前置（供排期参考）

1. 引入 `vitest` + `jsdom` + `@testing-library/react` + `@testing-library/user-event` + `@testing-library/jest-dom` + `msw`，新增 `apps/web/vitest.config.ts`（需 `@vitejs/plugin-react` 或 `@vitejs/plugin-react-swc`）。
2. `apps/web/package.json` 增加 `"test": "vitest run"`、`"test:coverage": "vitest run --coverage"`（当前 `test:unit` 必须保留，现有 108 个 `node:test` 用例仍在用 Node 原生 runner，两套需并存或迁移）。
3. 把 `apps/web` 的测试接入 `.github/workflows/deploy.yml` 的 `verify` job（当前只有 `typecheck` + `build`），并给 E2E 增加独立 job 提供 `PLAYWRIGHT_BASE_URL` 与 `TEST_DATABASE_URL` —— 否则 `playwright.config.mjs:4-5` 会直接抛 `TEST_BLOCKED`。
4. 建议把 13 个"源码正则"测试里真正的行为契约（防重复提交、silent 刷新、状态映射）迁移为组件测试，保留 `page-data-alignment.test.mjs` 这类**结构化检查**（它捕获的"11 个接口解构错位"是类型系统抓不到的真实缺陷类别）。

---

## 附录 A：本报告所有结论的证据来源

| 结论 | 证据 |
|---|---|
| 79 个非测试源码 / 5039 LOC / 61 `.tsx` / 18 `.ts` | `apps/web` 递归扫描（排除 `node_modules`、`.next`），LOC 用 `Measure-Object -Line` |
| 21 个 `page.tsx` + 1 个 `layout.tsx`；`loading/error/not-found/template/route` = 0 | `apps/web/app` 递归筛选文件名正则 |
| `features/` 不存在 | `apps/web/features` 路径不存在 |
| 51/61 `.tsx` 未被任何 lib 测试引用 | 把 20 个 `.test.mjs` 全文拼接后对每个 `.tsx` 相对路径做子串匹配，命中 10、未命中 51 |
| 13/20 测试用 `readFileSync` | 对每个 `.test.mjs` 全文匹配 `readFileSync` |
| 108 tests / 108 pass / 761.7ms | 实跑 `npm -w @dilee/web run test:unit` |
| 根 `test`/`test:unit` 不含 web | 根 `package.json` scripts 字段 |
| CI 不跑测试 | `.github/workflows/deploy.yml` 的 `verify.steps` 只有 `npm ci` / `prisma generate` / `typecheck` / 两个 `build` |
| 全部测试包 ABSENT | 对 `node_modules` 与 `apps/web/node_modules` 两处 `Test-Path`，14 个包逐个判定 |
| config 文件 ABSENT | `Test-Path` 逐个判定 12 个候选路径 |
| `useTransition` / 403 处理 / 权限判定 全库为 0 | 全库 `grep`，命中处逐条人工核对（均为 ARIA `role`、注释、或 401） |
| `disabled=` 共 29 处 | `grep 'disabled=\{'` 在 `apps/web/**/*.tsx` 计数 |
| 15 个文件有 Button 且 `disabled` 为 0 | 逐文件 `[regex]::Matches` 计数 `<Button` 与 `disabled` |
| `run()`/`action()`/`request()` 内部无 in-flight 标志 | 逐个读取函数体：`app/hr/page.tsx:164-183`、`app/warehouse/page.tsx:45`、`app/sales/page.tsx:45`、`app/finance/page.tsx:31`、`app/finance/salary/page.tsx:82`、`app/procurement/page.tsx:82`、`app/production/page.tsx:59`、`app/warehouse/raw-material-storage/page.tsx:83`、`app/warehouse/finished-goods-storage/page.tsx:90`、`components/hr/organization-pool.tsx:27`、`components/production/master-data-pool-page.tsx:43`、`components/production/unit-pool-page.tsx:42`、`components/production/outsource-logistics-panel.tsx:20`、`components/warehouse/finished-goods-qc-panel.tsx:68`、`components/production/production-order-detail-page.tsx:43` |
| adapter 层是死代码 | `module-placeholder.tsx:6` 是 `getModulePlaceholder` 唯一调用方，且 `module-placeholder.tsx` 无任何 import 方；`getWorkbenchData` 无调用方（全库 grep） |
| E2E 不可直接复现 | 3 个 spec 顶部 `TEST_BLOCKED` 抛错（各 `:7`）；`playwright.config.mjs:4-5`；`scripts/run-tests.mjs:27-28`；本机 `PLAYWRIGHT_BASE_URL`/`TEST_DATABASE_URL` 均 UNSET |
| 最近一次 E2E 失败 | `docs/test/results/playwright-result.json` 的 `stats.unexpected=1`、`expected=0`；唯一 spec `ok=False`，`duration=70561ms` |

## 附录 B：显式标注为「未验证」的事项

1. **CSRF 防护**：未检查后端是否依赖 `SameSite` cookie 或需要 CSRF token；前端无 token 注入代码，但这是否构成漏洞 **未验证**（需读取 `apps/api`，超出本次前端勘察范围）。
2. **后端 403 的实际响应体形状**：`app/production/material-issues/page.tsx:9` 注释称"非管理员会收到后端 403 提示"，但后端返回的 `error.code` 具体取值 **未验证**；因此无法确定前端能否可靠区分 `FORBIDDEN`。
3. **`/auth/me` 的失败 code 集合是否完整**：`app-shell.tsx:32` 白名单为 `["UNAUTHORIZED","UNAUTHENTICATED","AUTH_REQUIRED","SESSION_EXPIRED"]`，后端是否还会返回其它会话失效 code **未验证**。
4. **E2E 是否曾在其它环境全绿**：`docs/test/results/` 下有 20+ 份历史报告（如 `2026-08-24-frontend-full-migration-gate.md`），本次**未逐份阅读**以统计历史通过率。仅确认仓库留存的 `playwright-result.json` 为 1 failed。
5. **组件级覆盖率数字**：因 `c8`/`nyc`/`@vitest/coverage-v8` 全部缺失，**无任何前端覆盖率数据**；本报告中的"X/Y 未覆盖"均为**文件级引用统计**，不是行/分支覆盖率。
6. **`.env` 之外的运行期配置**：是否有其它来源（如部署脚本、`ecosystem.config.cjs`）注入 `PLAYWRIGHT_BASE_URL` / `TEST_DATABASE_URL` **未验证**；本报告的"不可跑"结论基于本机当前 shell 环境与 `.env` 文件。
7. **`components/panels/panels.tsx`（FormPanel）与 `components/ui/*` 的若干薄封装**（`card.tsx`、`separator.tsx`、`badge.tsx`、`label.tsx`、`sheet.tsx`、`alert-dialog.tsx`、`form.tsx`、`file-input.tsx`、`toast.tsx`）是否被真实业务路由使用 **未逐个 grep 验证**；它们同样零测试。
