# W5 第一波执行结果（前端行为测试）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：`docs/test/01-test-master-plan.md` §5.1 **W5（P4 前端）**，第一波 9 个目标
- 方式：9 个 agent 并行编写**真实行为测试**（渲染 + 交互），用于取代现有的源码正则断言

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 新增行为测试文件 | **9 个**（`apps/web/test/*.test.tsx`） |
| 新增用例 | **228**（前端组件测试 40 → **268**） |
| 取代的源码正则测试 | 覆盖 12 个 `lib/*.test.mjs` 中大部分断言意图（映射见 §4） |
| 生产代码改动 | **0**（仅新增测试文件；`apps/web` 生产文件在最近 40 分钟内无改动，已核验） |
| 实测 | `npx vitest run` → **16 files / 268 tests 全绿**；`npm run typecheck` 干净 |

**四级门禁全绿**：单元 **1,220**（后端 844 + 前端 lib 108 + 前端组件 268）、集成 **9**、契约 **355**、E2E **5**。

**本轮的价值不只是"多了 228 条用例"**：这 9 个文件第一次让这些组件**真的被渲染、真的被点击**，于是立刻照出了此前 12 个源码正则文件永远照不出的**系统性缺陷**（见 §3）。

---

## 2. 逐文件清单

| 测试文件 | 取代的遗留文件 | 覆盖要点 |
| --- | --- | --- |
| `production-order-detail-page.test.tsx` | collapsible-panel、production-material-issue-entry、refresh-policy、format-rate(部分)、finished-goods-storage(部分) | 概览字段、状态流转与对话框、工序面板展开/收起 + localStorage 记忆、工序列表、阻塞项、静默刷新 vs 整页刷新 |
| `material-issues-panel.test.tsx` | production-material-issue-entry、warehouse-issue-sheet(部分) | 新建入口、行操作、提交中禁用、失败提示、onChanged 回调 |
| `material-slip-editor.test.tsx` | auto-open-pages(部分)、warehouse-issue-sheet(部分) | 行增删、同物料不可重复、数量输入、保存草稿 vs 保存并出库、busy 禁用、预览数字 |
| `daily-reports-panel.test.tsx` | daily-reports-panel | 草稿行、员工批量选择、保存请求体、汇总、加载/错误态 |
| `finished-goods-qc-panel.test.tsx` | finished-goods-storage(部分) | 来源列表、送检单创建、提交/取消、QC 记录、错误态 |
| `finished-goods-panel.test.tsx` | finished-goods-storage(部分) | 列表渲染、入库/不良品入口、执行方式与状态差异 |
| `finance-page.test.tsx` | finance-draft-edit-method | **草稿编辑必须用 PATCH**（改断言真实请求 method，而不是断言源码写法）；加载失败与重试 |
| `workbench.test.tsx` | format-rate、finished-goods-storage(部分) | 订单行渲染、筛选加载、查看详情跳转、生产计量与完成率格式化 |
| `outbound-notice-pages.test.tsx` | outbound-notice-entries | 出库通知明细的可编辑单元格、增删行、提交请求体形状 |

---

## 3. 系统性缺陷：表格里的枚举值**从不被中文化**

### 3.1 我之前的一个判断是错的，先更正

我在上一轮报告里说"工序状态 `active` 被渲染成员工标签**「在职」**"。**这是错的。**
修复 agent 独立复核后指出实际渲染的是**原始英文 `active`**，并给出了 DOM 证据（`1裁剪120-active编辑`、`2缝制110件cancelled`）。
我随后自己读代码确认了真正的机制（下面 §3.2），**我的原判断错在**：以为 `data-table.tsx:14` 的 `displayText` 兜底会作用于单元格。

### 3.2 真正的机制（已逐层验证）

```tsx
// apps/web/components/data/data-table.tsx:14-15
const text = (value: ReactNode) => typeof value === "string" ? String(displayText(value)) : value;
...
text(flexRender(cell.column.columnDef.cell, cell.getContext()))
```

1. `flexRender(Comp, props)` 的实现（`@tanstack/react-table`）：
   `!Comp ? null : isReactComponent(Comp) ? createElement(Comp, props) : Comp`
2. TanStack 会为**没有自定义 `cell` 的列注入一个默认 `cell` 函数**
   （`table-core/build/lib/index.mjs:2872`：`cell: props => ...props.renderValue()...`）。
3. 因此对**任何表体单元格**，`flexRender` 返回的都是**React 元素**（不是字符串），
   于是 `text()` 的 `typeof value === "string"` 判定为假 → **`displayText` 被完全跳过**。
4. `displayText` 只对**表头**生效（表头通常是字符串字面量）。

**后果**：`data-table.tsx:14` 的 `displayText` 桥接对表体而言是**死代码**；
所有表格里的枚举值都以**英文原值**呈现给用户，除非该列自带 `cell` 做翻译。

**独立佐证**（不依赖本轮任何测试）：
- `tests/e2e/production-daily-report.spec.mjs:210` 断言工作台「计量状态」单元格的字面值就是 `over_order`；
- `lib/display-text.ts:2` 明明维护了 `confirmed: "已确认"`、`active: "在职"` 等一整套中文映射 —— 说明作者**本意**是要翻译表格值的，只是桥接失效。

**影响面**：全站所有用 `DataTable` 的列表页（工作台的销售状态/计量状态、生产单详情的工序状态、财务/仓库各列表等）。

**建议修法**（二选一，都很小）：
- 在 `data-table.tsx` 里对**渲染结果**做翻译：把 `flexRender` 的结果在是纯字符串时再过 `displayText`；
- 或改回 `cell.getValue()` 取原始值后统一 `displayText`，把翻译职责收进 DataTable。

### 3.3 本轮顺带固化的小缺陷

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | 生产单**工序**状态列复用了只含**生产单**状态的 `statusLabel`（`production-order-detail-page.tsx:74` + `:27`），落到原值 → 用户看到 `active` / `cancelled` | 已写 `KNOWN_DEFECT` 护栏 |
| 2 | 工作台「销售状态」「计量状态」两列是裸 accessor → 原值 `confirmed` / `recorded` | 同上（属 §3.2 的一个实例） |

> 另有 3 处"重复元素"失败在修复过程中被判定为**测试查询歧义（测试自身问题）**，不是产品缺陷；
> 修复时改用 `within(...)` 作用域限定，**没有弱化任何断言**。

---

## 4. 遗留源码正则测试的处理状态

12 个 `lib/*.test.mjs` 全部是"读 `.tsx` 源码做正则断言"（已逐个确认），本轮的 9 个行为测试**覆盖了它们的主要断言意图**（映射见 §2）。

但它们**尚未删除**。删除前需逐个确认"意图确实被继承"，理由：
- 它们把 JSX 书写形式当契约 → 任何等价重构都会误红；
- 但直接删掉会丢失它们声称守护的行为，若新测试其实没覆盖到就成了覆盖面倒退。

**建议下一步**：按 §2 映射逐个比对，确认后删除已在行为测试中覆盖的那些（预计 8–10 个），
保留确有独立价值者（如 `page-data-alignment` 这类跨页面字段对齐检查）并改造为静态断言测试。

---

## 5. 环境事故记录（已写入 Runbook）

本轮验证期间 **Docker Desktop 自行退出**，PostgreSQL 随之不可达，表现为：

| 现象 | 真因 | 处理 |
| --- | --- | --- |
| `/api/v1/health` 返回 **503「数据库不可用」** | 5432 无监听，Docker daemon 已停 | 重启 Docker Desktop，等 `docker info` 就绪后再 `docker compose up -d postgres` |
| **集成测试挂起至超时（600s）** | Prisma 连接等待，无快速失败 | 同上 |
| E2E 首次运行 3/5、重跑 5/5 | 数据库刚恢复，API 连接池尚在预热 | 等健康检查稳定后重跑；连跑 3 次均 5/5 |

> 这是计划里登记的风险 **R1（环境无法解阻）** 的实例。教训：**在跑链路门禁前先探一次 5432**，
> 否则会把"数据库没起来"误读成测试失败。

---

## 6. 下一步

- **W5 第二波**：其余组件的真实行为测试（`organization-pool`、`unit-pool-page`、`master-data-pool-page`、`outsource-logistics-panel`、`payroll-export-panel`、`searchable-select`/`multi-checkbox-select` 的交互，以及各 `page.tsx` 的加载/错误态）
- **W5 收尾**：按 §4 逐个删除已继承的源码正则测试
- **W3 第二波**：剩余后端单元（`raw-material-movements` 462 行、`material-slip-export` 494 行等）
- **W4 第二波**：剩余控制器 + `@Res()` 导出端点专项 + IDOR 专项

**另有两项已报告待决**：D11（非 UUID 路径参数返回 500，影响全站所有 `:id` 路由）与 §3.2 的表格枚举未中文化。
