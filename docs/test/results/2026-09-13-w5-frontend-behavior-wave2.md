# W5 第二波执行结果（前端行为测试补齐 + 遗留正则测试裁定 + 一处 CI 阻塞修复）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：`docs/test/01-test-master-plan.md` §5.1 **W5（P4 前端）** 第二波，含对 12 个遗留源码正则测试的逐个裁定

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 新增行为测试文件 | **6 个** |
| 新增用例 | **142**（前端组件测试 268 → **410**） |
| **修复一处 CI 阻塞** | 全量前端套件在 16 核机器上会 `FATAL ERROR` exit 134；已修复并验证 |
| 生产代码改动 | **0** |
| 遗留正则测试裁定 | 逐个给出四选一结论：**仅 1 个可安全删除**，7 个需先补测试，2 个应改造保留 |

**四级门禁全绿**：单元 **1,362**（后端 844 + 前端 lib 108 + 前端组件 410）、集成 **9**、契约 **355**、E2E **5**。

---

## 2. 逐文件清单（新增 142 例）

| 测试文件 | 用例 | 覆盖要点 |
| --- | ---: | --- |
| `searchable-select-interaction` | 30 | 两个自研下拉的**交互行为**：输入过滤、键盘上下键/Enter/Escape、无匹配文案、受控回显、`disabledValues` 不可选、多选顺序与计数 |
| `organization-pool` | 27 | HR 组织池：加载/错误/空态、部门与岗位列表数据流、行内操作矩阵、新建/编辑请求体、停用/启用/删除/恢复、筛选（含真实 Radix Select 交互） |
| `outsource-logistics-panel` | 23 | 外加工批次列表、回厂与直装柜合并表、派遣/签收/退货/直发、提交请求体 |
| `app-shell` | 22 | **会话与权限门禁**：`/auth/me` 成功→渲染导航、未认证类 code→跳 `/login`、pathname 变化重新校验、切页后过期即跳转、退出登录、`/login` 旁路 |
| `payroll-export-panel` | 22 | 导出触发下载、失败提示、导出中禁用、订单为空的表现 |
| `unit-pool-page` | 18 | 单位池：加载/错误/空态、搜索、新建/编辑请求体与备注空值语义、停用/启用、删除、防重复提交 |

---

## 3. 修复了一处 CI 阻塞（重要）

**症状**：22 个前端测试文件一次性运行时，进程崩溃：

```
FATAL ERROR: NewSpace::EnsureCurrentCapacity Allocation failed - JavaScript heap out of memory
FATAL ERROR: Zone Allocation failed - process out of memory
EXIT: 134
```

**根因**：Vitest 默认按 **CPU 数**开 worker —— 本机 **16 核**，22 个 jsdom + Radix 组件测试文件同时跑会把内存打爆。
注意堆只有 40–100 MB 就崩，所以这**不是"测试太重"**，而是并发度过高导致的分配失败；
很容易被误读成"某个测试写错了"（本轮就有一份 agent 报告把它当成测试失败）。

**修复**：`apps/web/vitest.config.mts` 增加 `maxWorkers: 4`（含成因注释）。实测：

| worker 上限 | 结果 | 耗时 |
| ---: | --- | ---: |
| 默认（16） | ❌ exit 134 | — |
| 2 | ✅ 22 files / 410 tests | 52s |
| 3 | ✅ 全绿 | 36s |
| **4（采用）** | ✅ **全绿** | **27s** |

已在**纯 `npx vitest run`** 与 **`npm run test:components`** 两条路径上各验证一次全绿。
CI 的 2 核机器本就不会触及该上限，因此该设置只影响本地大核机器。

---

## 4. 遗留源码正则测试：逐个裁定（**推翻我先前"删掉 12 个"的建议**）

我在 W5 第一波建议"确认后删除已在行为测试中覆盖的那些（预计 8–10 个）"。**这个预估是错的，不能删那么多。**

对 12 个文件逐个比对后（判定口径：该文件**每一条**断言守护的行为，能否在新套件里找到一条"回归即变红"的用例）：

| 遗留文件 | 实际断言什么 | 裁定 |
| --- | --- | --- |
| `format-rate` | 纯函数 3 条 + 源码写法 1 条 | ✅ **可安全删除**（新测试逐字覆盖了全部 3 组纯函数断言与那 1 条 UI 断言） |
| `collapsible-panel` | 纯函数 4 条 + 源码写法 1 条 | 🔧 **应改造保留**（保留纯函数单测；源码那条可删） |
| `page-data-alignment` | **结构性契约**（不是 JSX 写法）：`Promise.all` 绑定数=请求数、页面接口顺序语义 | 🔧 **应改造保留**（曾捕获过"10 个请求只有 9 个绑定"的真实缺陷） |
| `auto-open-pages` | 源码写法 4 条 | ⚠️ 需先补测试（4 条里只有 1 条被覆盖；采购页/仓库页/原料仓储页**没有任何行为测试**） |
| `daily-reports-panel` | 源码写法 5 条 | ⚠️ 需先补测试（"改了时长就要提交"只覆盖了负向） |
| `finance-draft-edit-method` | 源码写法 3 条 | ⚠️ 需先补测试（收款/付款「过账核销」的 `/post` 无人点击） |
| `finished-goods-storage` | 源码写法 9 条 | ⚠️ 需先补测试（7 处缺口，入库通知/QC 记录/不良品仅作桩存在） |
| `material-issue-page-actions` | 源码写法 5 条，对象是**领料单列表页** | ⚠️ 需先补测试（**没有任何新测试渲染该列表页**） |
| `outbound-notice-entries` | 源码写法 5 条 | ⚠️ 需先补测试（签收/冲销/取消出库单三条端点只断言"按钮存在"，从未点击） |
| `production-material-issue-entry` | 源码写法 | ⚠️ 需先补测试 |
| `refresh-policy` | 混合（含纯函数） | ⚠️ 需先补测试 |
| `warehouse-issue-sheet` | 源码写法 | ⚠️ 需先补测试 |

**结论：只删 `format-rate` 一个。** 其余 11 个若直接删除会造成真实覆盖面倒退 —— 这正是"先审计再动手"的价值。

**根因（结构性）**：新行为测试只渲染了 **5 个路由页**（`/reports`、`/finance`、`/sales`、`/warehouse/finished-goods-storage`、`/`）；
**21 个路由页中只有 5 个有组件级测试**，`/procurement` 与 `/warehouse/raw-material-storage` 更是**全仓库零自动化覆盖**（E2E 也不访问）。

---

## 5. 本波新固化的产品缺陷

| # | 缺陷 | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | **`DataTable` 从不中文化单元格值**（第三次独立确认，机制已完全锁定） | `components/data/data-table.tsx:14` 的 `typeof value === "string"` 守卫对单元格**不可达**：table-core 为无自定义 `cell` 的列注入默认 `cell`（返回字符串），而 `flexRender` 把该函数包成 `React.createElement` | 已在 `outsource-logistics-panel`（批次状态、transferType）、`finished-goods-qc-panel`、`production-order-detail-page`、`finance-page` 四处钉为 `KNOWN_DEFECT` |
| 2 | `app-shell.tsx:36` `logout()` **无 try/catch** → 请求失败时 rejection 逃逸为未处理拒绝（用户无任何提示、也不跳转） | 新测试用 `escapedRejections` 正向捕获该逃逸并断言其 message | `KNOWN_DEFECT` 钉住 |
| 3 | `app-shell.tsx:46` 退出登录**无 in-flight 守卫** → 连点发两次 `POST /auth/logout` | 断言 `callsTo(calls,"/auth/logout")` 长度为 2 | `KNOWN_DEFECT` 钉住 |
| 4 | **连点发重复写请求**（recon D4）：HR 组织池删除/停用/恢复无 in-flight 标志 | 用在途请求挂住后连点，断言真实请求次数 | `KNOWN_DEFECT` 钉住；**注意：recon 当时给的"入口加 disabled"修法不成立**，此处的在途请求一挂住按钮仍可点 |

> 另有 1 处"提交调用计数为 3"的失败被判定为**测试自身缺陷**（`callsTo()` 是后缀匹配，一次成功创建会产生挂载 GET + POST + 重载 GET 三次命中），已改为 method+精确 URL 的辅助函数；**断言未弱化**。

---

## 6. 下一步

- **W5 第三波**：补齐 §4 点名的缺口 —— 重点是 16 个无组件级测试的路由页（`/procurement`、`/warehouse`、`/warehouse/raw-material-storage`、`/production/material-issues` 列表页、`/production/orders/[id]` 等），以及 `daily-reports-panel` 的"改了就提交"正向路径、财务 `/post` 核销
- **W5 收尾**：完成 §4 的 `format-rate` 删除与 `collapsible-panel`/`page-data-alignment` 改造
- **W3 第二波**：剩余后端单元
- **W4 第二波**：剩余控制器 + `@Res()` 导出端点专项 + IDOR 专项

**已报告待决的三项修复**：D11（非 UUID 路径参数 500）、表格枚举未中文化（§5.1）、`app-shell` 退出登录的两个缺陷（§5.2/§5.3）。前两项影响面最大，修法都很小。
