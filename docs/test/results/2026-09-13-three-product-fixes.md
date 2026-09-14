# 三个已确认缺陷的修复记录（3 → 2 → 1）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：修复 `docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md` §7 记录的三个产品问题
- 顺序：按用户指定 3 → 2 → 1（成本递增、影响面递增）

---

## 1. 结论

三个缺陷全部修复，各自配有回归护栏；**四级门禁仍全绿**：

| 层 | 用例 | 结果 |
| --- | ---: | --- |
| 单元（后端 474 / 前端 lib 108 / 前端组件 40） | **622** | ✅ |
| 集成（真实 PostgreSQL） | 9 | ✅ |
| HTTP 契约（真实 API） | 19 | ✅ |
| E2E（浏览器 + Web + API + DB） | 5 | ✅ |

新增测试 **15 条**（前端组件 3 + 4 + 8），另在 E2E 中新增 1 条端到端验收断言。

---

## 2. 修复 3：基础资料加载完成前不得打开对话框

### 缺陷

`openCreate()` / `openProductionOrder()` 会把**当时**的 `units` / `activeLocations` 快照进 `dialog.fields`；
数据到达后 `dialog.fields` **不会重建**，于是下拉**永久为空**且无法恢复。用户手速快一点就会遇到。

### 根因定位（含"哪些页面其实不受影响"）

`ActionDialog` 的 `fields` 是不会被父组件重建的 state 快照，因此只有「入口按钮在 loading 期间也可点」的页面才会踩到。

实测排查 14 个含 `ActionDialog` + `options` 的页面：

| 页面 | 是否受影响 | 依据 |
| --- | --- | --- |
| `components/production/master-data-pool-page.tsx` | ✅ 受影响 | `PageHeader` 的建单按钮在 loading 门禁之外，始终渲染 |
| `app/production/page.tsx` | ✅ 受影响 | 同上 |
| `app/procurement/page.tsx`、`app/sales/page.tsx`、`app/warehouse/page.tsx` | ❌ 不受影响 | loading 时**提前 return** `<PageHeader/><LoadingState/>`，操作按钮根本不存在 |
| `components/hr/organization-pool.tsx`、`components/production/production-order-detail-page.tsx` | ❌ 不受影响 | 其对话框没有任何 option 列表 |
| 其余（finance / hr / warehouse 子页 / qc-panel 等） | ❌ 不受影响 | 同上两类之一 |

→ **修复范围精确为 2 个文件**，而不是盲目改 14 个。

### 修法

两个入口按钮加 `disabled={loading}`（并写明原因注释）。这同时消除了"打开时数据还没到"的竞态。

### 护栏（3 条，`apps/web/test/dialog-entry-loading-guard.test.tsx`）

- 加载未完成时「新建工序」禁用、完成后启用（用可控 deferred 把页面稳定停在 loading）；
- **加载完成后打开对话框，默认单位下拉里确实能看到已加载的单位** —— 这正是修复前永久为空的场景；
- 加工地点入口同样受门禁保护。

---

## 3. 修复 2：告警中心确认未联动生产日报告警

### 缺陷

`POST /alerts/:id/handle` 只写 `alert_handling`（`alerts.service.ts:21`），而订单侧的阻塞只看
`production_daily_alert.status === "pending"`（`production-progress.service.ts:169-170`）。
因此"已确认"的告警**仍然阻塞生产单**；而 `/production/daily-alerts/:id/confirm` 没有任何前端调用方。

### 修法

`app/reports/page.tsx` 的 `handleAlert`：当 `source_type === "production_daily_alert"` 时，
在 `handle` 之后再调 `POST /production/daily-alerts/{source_id}/confirm`（带上同一备注）。

**边界处理**：`recovered` 状态的告警不允许再确认（`RECOVERED_ALERT_CANNOT_CONFIRM`），
而它本来也不再产生阻塞 —— 对该码做定向容忍，避免打断用户的确认流程；
**其它错误照常抛出**，不被吞掉。

### 护栏（4 条，`apps/web/test/alert-confirm-linkage.test.tsx`）

- 确认生产日报告警时**同时**发出两次调用，且 confirm 带上同一备注；
- 成品 QC 等非生产日报类告警**不触发**该联动；
- 已恢复告警（422 `RECOVERED_ALERT_CANNOT_CONFIRM`）不阻断用户流程、也不显示错误；
- 联动的**其它**错误（如 404）仍然暴露给用户。

### 端到端验收（新增 E2E 断言）

在 `tests/e2e/production-daily-report.spec.mjs` 第 6b 步：在告警中心确认后回到生产单详情，
断言概览里**不再出现「日报数量差异」**。修复前该断言会失败（阻塞仍在），是真实缺陷的端到端证据。

---

## 4. 修复 1：searchable-select 弹层被裁切导致顶部选项鼠标点不到

### 缺陷

原实现只比较"下方空间是否 ≥288"，不够就朝上，**却没检查上方是否够**。
弹层绝对定位在触发点所在的裁切盒（宿主对话框 `.ui-dialog-content` 有 `overflow:auto`）内，
触发点靠近对话框顶部时，朝上的弹层伸出上边缘被裁掉 —— 顶部若干选项鼠标点不到（键盘仍可达，
所以"测试通过"与"用户点不到"并存）。

### 修法

把朝向决策抽成**可单测的纯函数** `choosePopoverPlacement({ spaceAbove, spaceBelow })`：

1. 能整高容纳（≥288）的一侧优先；
2. 都容纳不下 → 选**空间更大**的一侧（原实现出错的分支：`spaceBelow=265 < 288` 时会无条件朝上，而上方只有 84）；
3. 把弹层高度**限制在该侧可用高度内**（内联 `maxHeight`），保证弹层整体落在裁切盒内、每个选项都可点。

未改为 portal：那会让弹层脱离 `rootRef`，与既有的「外部点击即关闭」判定冲突
（点选项会被当成外部点击而先关闭），对全站所有对话框都是回归风险。当前改法保持绝对定位，
行为面最小。

### 护栏（8 条，`apps/web/test/searchable-select-placement.test.tsx`）

- 5 条纯函数用例：下方足够→朝下；仅上方足够→朝上；**两侧都不足→选更大一侧（回归点）**；上方可用高度收敛；**不变量「高度永不超过该侧空间」**；
- 3 条组件用例：用可控矩形模拟真实布局（jsdom 无布局，`getBoundingClientRect` 全为 0），
  断言类名与内联 `maxHeight` 与实际可用空间一致 —— 其中第一条直接复刻实测几何
  （对话框 `[186,535]`、触发点在顶部，期望「朝下 + 231px」而不是「朝上被裁」。

### 顺带补齐的测试环境桩

`apps/web/test/setup.ts` 补了 jsdom 缺失的 `hasPointerCapture` / `setPointerCapture` /
`releasePointerCapture` / `scrollIntoView` / `ResizeObserver`。
Radix 的 Select 依赖它们，缺失时会抛 `TypeError: target.hasPointerCapture is not a function`
—— 这类报错容易被误读成"组件有问题"。

---

## 5. 过程中踩到的坑（已写入 Runbook）

`next build` 会**清掉** `apps/web/.next/standalone/apps/web/.next/static`。
手工启动 standalone server 时若不复制静态资源，页面 HTML 会引用 404 的 CSS/JS，
表现为**全部 E2E 用例失败**（连未改动的认证用例也失败），极易误判为产品回归。

症状：`expect(page).toHaveURL failed`、`element(s) not found`，且 `/_next/static/...` 请求失败。
处理：`npm run build` 之后必须把 `.next/static` 复制进 standalone 目录
（Playwright 的 `webServer` 命令自带这一步，手工启动时需自己做）。

---

## 6. 下一步

三个缺陷已闭环，四级门禁全绿，进入大规模测试扇出：**W3–W5**（P1 后端单元 / P2 HTTP 契约 / P4 前端）。
