# E2E 重写 + 平台层单元测试扩张 —— 执行结果

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：① 重写 3 条写在已废弃 UI 上的 E2E spec；② 补平台层单元测试（守卫 / 过滤器 / 拦截器 / 审计 / 中间件）
- 环境：Windows 11 / PowerShell 5.1 / Docker 29.7.2 / Node v24.15.0

---

## 1. 结论

**CI 四级门禁全部转绿**，这是本项目测试工程首次全线贯通：

| 层 | 结果 |
| --- | --- |
| 类型检查 | ✅ |
| 单元（后端 474 + 前端 lib 108 + 前端组件 25） | ✅ **607 通过 / 0 失败** |
| 集成（真实 PostgreSQL） | ✅ **9 / 9** |
| HTTP 契约（真实 API） | ✅ **19 / 19**（连跑 6 次稳定） |
| E2E（真实浏览器 + Web + API + DB） | ✅ **5 / 5**（13 秒） |

---

## 2. 实跑证据

```text
npm run test                    → 后端 474 pass / 前端 lib 108 pass / 前端组件 25 pass    exit 0
node --test apps/api/test/integration/**   → tests 9   pass 9   fail 0
node --test apps/api/test/http/**          → tests 19  pass 19  fail 0   （连跑 6 次全绿）
npx playwright test                        → 5 passed (12.8s)
npm run typecheck                          → exit 0
```

---

## 3. 3 条 E2E spec 重写明细

前提已在前一份记录中确认：这 3 条 spec 依赖的字符串（`保存工序日报`、`查看服务端累计`、`生产日报与告警`、`新增生产地点`、`name="employee_id"`、`duration_minutes` 等）在 `apps/web` **全部零命中**，属**目标 UI 已被迁移重写**，而非选择器不稳定。

### 3.1 `production-order.spec.mjs`

**新流程**：登录 → `/production/locations` 新建加工地点 → `/production/operations` 新建工序（选单位）→ `/production` 新建生产单（订单号 searchable-select + 执行地点 Radix select）→ 点单号进详情 → 添加工序（多选）→ 启动生产（带原因）。

**保留的断言**：5 个 toast（加工地点已创建 / 工序已创建 / 生产单草稿已创建 / 工序已添加 / 启动生产成功）；新建地点与工序行可见；生产单行含订单号 + 地点 + `draft` + **自动补齐的「包装」工序** + 启动按钮；工序出现在「工序与进度」面板；概览显示「生产中」；日报面板显示原始 `状态：in_progress`；回到列表后行显示 `in_progress` 且启动按钮消失。
**无删减。**

### 3.2 `production-daily-report.spec.mjs`

**新流程**：详情页 →「工序员工日报」面板 → 批量选择员工 → 草稿行 → 保存日报（计件 6×2）→ 再开一条计时（1 小时 × 3 元）→ 保存 → 重载详情取服务端累计 → `/reports` 告警中心确认 → `/` 工作台查看生产计量。

**保留的断言**：保存 toast ×2；本工序已完成数量 6；服务端 measurements；工作台单元格 完成 6 / 计划 5 / 超单 1 / 计量状态 `over_order`；是否超单=是；生产日报差异告警行待处理 → 确认 → 已确认/解决；服务端阻塞项「日报数量差异」；金额 12.00 / 3.00 / 当日合计 15.00；订单全链路 → 进行中 → 查看详情 → 生产计量。

**有据可查的替换（非弱化）**：

| 原断言 | 处理与理由 |
| --- | --- |
| 「保存工序日报」按钮 | **工序日报在 Web 端已无入口**：`/production/operation-reports` 在 `apps/web` 零调用（已 grep 验证）。差异告警现由员工日报批量路径触发，spec 改断言该路径 |
| 字面量 `180` | 计时口径已从「元/分钟」改为「元/小时」（集成测试亦断言 1 小时 × 3 元 = 3）。断言 180 等于断言一个**错误的数字**，故改为 12.00 / 3.00 / 15.00 |
| 「查看服务端累计」`<pre>` | 该面板已移除；服务端累计改在详情页与工作台计量表断言 |
| 「状态与来源审计」 | 该字符串在 `apps/web` 不存在；替换为「模块状态」+ 生产计量列 |

### 3.3 `raw-material-movement.spec.mjs`

**新流程**：`/warehouse` 新建领料单 → 全屏编辑器 `/production/material-issues/new` → 选生产单（Radix）+ 该单 BOM 内物料 → 保存草稿 → 过账出库 → 回 `/warehouse` 看库存与影响/审计 → 退料过账 → 报废过账 → 冲销被拦。

**保留的断言**：已过账 toast 与行状态；草稿真实落库（草稿行）；编辑器预览 核定用量 5 / 当前库存 10 / 生产领用累计 2 / 生产未领用 5；**过账后真实余额 8**；库存影响对话框；退料已过账；报废已过账；冲销对话框含冲销原因；被拦 toast「存在后续退料或报废记录，不能冲销来源领料」且领料行仍为已过账。
**替换**：独立的「影响预览」标题与裸 `getByText("8")` → 改为断言编辑器内联预览 + 真实原料余额 8（更强，不再是"页面上某处有 8"）。

### 3.4 顺带修掉的两处夹具漂移

| 文件 | 漂移 | 处理 |
| --- | --- | --- |
| `raw-material-movement.spec.mjs` | 期初库存的 `inventoryFact` 带了 `production_order_id`。而 API 的「生产已领累计」= 该生产单原料类事实的**取负求和**（`raw-material-movements.service.ts:419`），于是期初 10 被算成 −10，预览显示 −8 | 期初库存不再挂 `production_order_id`（`rawMaterialBalance` 只按物料+单位聚合，10/8 数字不变） |
| `production-daily-report.spec.mjs` | 员工日报现在会写 `production_payroll_sources`，其外键会阻塞生产单/员工删除 —— 而浏览器这次真的会写入日报，旧 `afterAll` 必然失败 | `afterAll` 先按 orderNo 删 `productionPayrollSource`，再删其余 |

---

## 4. 独立验证：断言未被弱化、前端未被改功能

我没有只依赖执行者的自述，而是逐项复核：

| 验证项 | 方法 | 结果 |
| --- | --- | --- |
| 被删断言"目标 UI 确实不存在" | 对 `apps/web` 逐字符串 grep | `operation-reports`、`保存工序日报`、`查看服务端累计`、`状态与来源审计` **全部 0 命中** → 删减成立 |
| 前端改动仅为附加 testid | 把工作区与 `HEAD` 版本的 `data-testid="..."` **与** `data-testid={...}`（含模板串/三元）全部剥离后逐字符比对 | 13 个前端文件中 **11 个逐字符相同**；其余 2 个差异已定位为：`app/production/page.tsx` 的 `<>` → `<div className="page-root">`（S6 已记录并配 CSS 补偿），`searchable-select.tsx` 的**空行位移**（`role="combobox"` / `aria-autocomplete="list"` / `aria-expanded` 三个无障碍属性均完好，见 L202-204、L275-277） |
| 前端测试未被破坏 | `npx vitest run` | 25 / 25 |
| 类型未被破坏 | `npm run typecheck` | exit 0 |
| E2E 真实通过 | 亲自重启 API + Web 后跑全套 | **5 / 5**（13.5s） |

**结论：前端零功能变更，仅有惰性 `data-testid` 属性附加（3 个组件）+ S6 的页面根包装层。**

---

## 5. 新增 39 条平台层单元测试

利用等待 E2E 迭代的时间补齐了 recon 点名的平台层空白。全部为纯逻辑测试，无数据库、无网络。

| 新文件 | 用例 | 覆盖内容 |
| --- | ---: | --- |
| `unit/module-permission-guard.test.cjs` | 10 | **recon D6**：被 34 个控制器使用却零测试的权限守卫。覆盖无元数据放行、AND/ANY 语义、**「类级 modules 与方法级 ANY 是 AND 而非覆盖」**、管理员短路、`RequireAdministrator`、无用户时 403、软删角色不授权、查询条件下推、多角色权限并集 |
| `unit/authentication-guard.test.cjs` | 4 | 只认 Cookie `dilee_session`、**显式拒绝 Authorization: Bearer**（旧测试工具曾因此静默变匿名）、缺 cookies 不抛 TypeError、401 透传且不写 `currentUser` |
| `unit/response-envelope-interceptor.test.cjs` | 7 | 整个成功信封的形状；`undefined/null → data:null` 但 `0/""/false` 保留；**D2 在单元层的成因**；`{data, extra}` 的兄弟键会被静默丢弃（陷阱护栏） |
| `unit/error-envelope-mapping.test.cjs` | 10 | 六个状态码的机器码映射；字符串异常强制通用码；ValidationPipe 数组 message 的归一化；500 不泄漏内部信息；P2002 业务标签与兜底；**recon U2：P2025/P2003/P2034 当前全部落到 500 REQUEST_ERROR** |
| `unit/audit-and-request-id.test.cjs` | 8 | 请求 id 写响应头与 `request.requestId`、**D2 根因（中间件不回写请求头）**；`AuditService.record()` **不写 `orderNo` 列**、`recordWithOrderNo()` 才写、以及某事件可以完全没有订单引用（W1 记录的三个审计缺口） |

后端单元测试从 435 → **474**。

---

## 6. 修复一处自造的 flaky 测试（过程记录）

首轮全量 HTTP 契约测试出现 `18 pass / 1 fail`，重跑却全绿。我没有当作偶发放过，而是连跑 4 次复现（1/4 概率），定位到：

> `contract.envelope_success_always_wraps_data_and_meta` 对 `/api/v1/health` 硬断言 200。而 `node --test` **并行**执行 `test/http/` 下 5 个文件，数据库连接存在竞争，`/health` 会偶发返回 **503 `DEPENDENCY_UNAVAILABLE`**（`health.controller.ts:16`）。这是**测试自身的缺陷**，不是产品问题。

**修法（不是放宽，而是加强）**：让该断言接受两种合法结果并各自校验信封形状 —— 200 走成功信封、503 走错误信封；同时把 D2 用例的双向验证从匿名的 `/health` 改到已认证的 `/customers`（不依赖 DB 健康度）。
**修复后连跑 6 次：19/19 全绿。**

---

## 7. 发现的真实问题（未修，按要求先报告）

### 7.1 `searchable-select` 在 `ActionDialog` 内弹层被裁切，顶部选项鼠标点不到

| 项 | 内容 |
| --- | --- |
| 复现 | `/production` → 新建生产单 → 点「订单号」（候选 ≥ ~9 条未过滤）→ 弹层获得 `ui-searchable-select-popover-up`，渲染到对话框上边缘之外 |
| 实测几何 | 1280×720 下 选项框 `[5,37]`、弹层 `[0,266]`、对话框 `[186,535]`，`document.elementFromPoint(选项中心)` 返回 `div.ui-dialog-overlay`；Playwright 报 `<div class='ui-dialog-overlay'> intercepts pointer events`。仅 1 条候选（弹层 224..266）时同一命中测试返回选项本身，即**可点** |
| 责任位置 | `components/ui/searchable-select.tsx:116-117`（`bottomLimit` 取最近滚动祖先的 bottom，即对话框裁切盒，然后向上翻转 —— 翻到了同一个裁切盒之外）；裁切/层叠：`app/globals.css:69`（`.ui-dialog-content{overflow:auto}`）+ `globals.css:311`（`.ui-searchable-select-popover{position:absolute}`） |
| 影响 | **不阻塞**：spec 走组件自身的一等键盘路径（搜索框 + Enter），真实用户输入关键词后也可达；但候选较多时鼠标点选最上面几条会失效 |
| 建议 | 弹层改为 portal 到 body（或按视口而非滚动祖先计算翻转边界） |

### 7.2 告警中心「确认」只写 `alert_handling`，未联动生产日报差异告警

`apps/api/src/modules/alerts/alerts.service.ts:21` 仅 upsert `alert_handling`；`/production/daily-alerts/:id/confirm`（`production-daily-alerts.service.ts:27`）**没有任何前端调用方**。后果：在告警中心"确认"了一条「生产日报差异」后，订单侧仍然显示该阻塞（`日报数量差异`）。spec 已把"告警中心确认成功"与"阻塞仍在"**分别断言**，因此两种行为都被固化。

### 7.3 对话框可在主数据加载完成前打开，得到永久空的选项列表

点「新建工序」「新建生产单」时页面主数据仍在加载，此时打开的对话框拿到**空**的默认单位/执行地点选项且不会重新填充。两条 spec 均改为先等 `loading-state` 隐藏再打开对话框。这是**测试驱动暴露的可用性缺陷**（用户手速快时会遇到），建议产品侧在数据就绪前禁用入口。

---

## 8. 下一步

四级门禁已全绿，可以安全进入大规模测试扇出（`docs/test/01-test-master-plan.md` §5.1 的 W3–W5）：

- **W3** P1 后端单元（47 service + 20 纯函数 + 平台层）
- **W4** P2 HTTP 契约（37 控制器 + 5 横切）
- **W5** P4 前端（58 文件，含把 12 个源码正则断言文件改造为行为测试）
- **W6–W7** P3 集成并发 + P5 E2E 扩展（当前 E2E 仅 5 例，目标 28 例）

§7 的 3 个产品问题建议单独立项；其中 7.3 成本最低（入口加禁用条件），7.1 影响面最大（所有带 searchable-select 的对话框）。
