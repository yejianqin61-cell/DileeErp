# T13 Web：`.data-table-fixed` CSS 从 `.finance-page` 提为通用规则 + 财务四表回归

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §6.5、§2（口径 5）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T10](./10-web-plan-detail-sheet.md)/[T09](./09-web-plans-list-page.md)（有表要用它才有回归对象）。
可与 [T11](./11-web-purchase-order-slimming.md)、[T12](./12-web-bom-supplier-visibility.md) 并行。

## 目标

把「一次性展示所有 column + 超出省略 + hover 看全文」那套 CSS 从**只对财务页生效**提成**通用规则**，
让采购计划页（以及今后任何一个用 `DataTable` + `meta.width` 的页面）真的生效，
同时用**同等或更高的权重**保住财务那几张表的原有行为。

这是本批次里唯一的"看起来是重构、实际是修一个静默失效"的任务。

## 口径与决策（依据设计文档）

- **§6.5 现状**（`apps/web/app/globals.css:217-223`）：

  ```css
  .finance-page .ui-table.data-table-fixed { table-layout: fixed; }
  .finance-page .ui-table.data-table-fixed .ui-table-cell.cell-ellipsis,
  .finance-page .ui-table.data-table-fixed .ui-table-head.cell-ellipsis { white-space: nowrap; text-overflow: ellipsis; }
  ```

  → 前缀挂着 `.finance-page`，采购计划页照抄会得到**静默失效**（宽度不生效、省略号永远不出现，
  页面只是"看起来没省略"）。
- **口径 5**：「一次性展示所有 column」两个表都做 —— 只读列表能 hover 看全文（这一条正是靠这里的 CSS）。
- **§6.5 要求**：改成通用规则；财务的原有行为用同等或更高权重保住；
  对财务那四张表（**记账凭证 / 应付对账 / 应收对账 / 工资台账**）做一次回归。

## 范围与非范围

**范围**

- `apps/web/app/globals.css`：`217`（`table-layout: fixed`）与 `222-223`（省略号）两条去掉 `.finance-page` 前缀，
  变成通用规则；保留 `218`（`overflow: hidden`，它**本来就没有**前缀）。
- 冲突排查：财务页可能有**其它**规则依赖那个前缀的权重（例如 `.finance-page .ui-table-cell { white-space: normal }`），
  提通用规则时要把它们的先后与权重重新校一遍（`globals.css:219-221` 的注释就是这件事的历史）。
- 回归：记账凭证 / 应付对账 / 应收对账 / 工资台账四张表的既有前端用例（`finance-*` 系列）全绿。

**非范围**

- 不改 `DataTable` 组件本身的 `meta.width` / `meta.ellipsis` 逻辑（`components/data/data-table.tsx` 已支持）。
- 不改财务页的列定义（宽度、省略列的选择）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/web/app/globals.css` | 两条规则去前缀；注释改成"通用规则 + 财务页仍然生效"的说法；若需要保权重，用同等或更高的选择器（例如同时保留 `.finance-page …` 与通用两条，或统一成 `.data-table-fixed` 一条） |
| `apps/web/app/globals.css` | 注释里写清**为什么曾经挂在 `.finance-page` 上**、以及提通用之后靠什么保证财务不回归 |
| 既有财务前端用例 | 全绿即为回归证据（无需改断言；若必须改，说明行为真的变了 → 回到设计文档确认） |

## 实施要点

### 1. 规则怎么写才"通用且不回归"

- 目标形态（与既有写法同一层语义）：

  ```css
  .ui-table.data-table-fixed { table-layout: fixed; }
  .ui-table.data-table-fixed .ui-table-cell,
  .ui-table.data-table-fixed .ui-table-head { overflow: hidden; }   /* 218 已经是通用的，别重复 */
  .ui-table.data-table-fixed .ui-table-cell.cell-ellipsis,
  .ui-table.data-table-fixed .ui-table-head.cell-ellipsis { white-space: nowrap; text-overflow: ellipsis; }
  ```

- **权重必须压过** `.finance-page .ui-table-cell { white-space: normal }`（`(0,2,1)`）：
  `globals.css:219-221` 的注释明确写了"写成 `.cell-ellipsis`（(0,1,0)）会静默失效"，
  所以省略号那条必须保持 `(0,4,1)` 级别的选择器（`.ui-table.data-table-fixed .ui-table-cell.cell-ellipsis`）。
- **不要**用 `!important` 绕过权重：它会让"下一层想覆盖"变成不可能，而财务页还有自己的列宽规则。

### 2. 静默失效的判定方法（这条要写进完成记录）

- jsdom **不排版**：删掉前缀之后，组件测试**不会**变红也不会变绿 —— 所以"测试全绿"**不能**作为
  "CSS 生效"的证据。
- 可行的证据链（按优先级）：
  1. 构建通过（`npm run build --workspace=@dilee/web`）+ 类名确实出现在 DOM（`data-table-fixed` / `cell-ellipsis`
     由 `DataTable` 自动加，见 `data-table.tsx:63-64`）；
  2. 选择器权重的人工复核（把新旧两条规则的 specificity 写进完成记录）；
  3. **部署后浏览器目测**：财务四表 + 采购计划表在 1366 / 1440 / 1920 下没有横向滚动条、
     长文本出现省略号、hover 有全文（`title`）。

### 3. 财务四表回归怎么做（本机限制下）

- 跑 `cd apps/web; npm run test:unit` 全量（含 `finance-*` 系列），确认没有断言因为类名/结构变化而红。
- 若某条财务用例断言的正是"某列宽度/省略"的行为，先看它断的是什么：
  - 断类名/结构 → 提通用规则不该改变它；
  - 断具体像素 → 本机没有像素，那是环境阻断，记进完成记录。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 两条规则不再带 `.finance-page` 前缀；`overflow: hidden` 那条未被重复定义 | 源码断言（grep 规则文本） |
| 2 | 省略号那条的 specificity **不低于**原 `.finance-page` 版本 | 人工复核权重，写进完成记录 |
| 3 | 没有引入 `!important` | 源码断言 |
| 4 | `DataTable` 仍按 `meta.width` 自动加 `data-table-fixed` | 既有 `data-table` / 列宽相关用例 |
| 5 | 财务四表（记账凭证/应付对账/应收对账/工资台账）用例全绿 | `cd apps/web; npm run test:unit` |
| 6 | web 构建通过 | `npm run build --workspace=@dilee/web` |
| 7 | 类型检查 | `npm run typecheck` |
| 8 | 真机观感（省略号、hover 全文、无横向滚动） | **部署后目测**（设计文档 §9 第 3、6 条） |

## 决策记录

- **提成通用规则而不是给采购页再复制一份带 `.finance-page` 的规则**：复制一份等于把"两处规则打架、
  其中一个静默失效"这个坑复制一遍——而那正是本任务要修的东西。
- **不用 `!important`**：见"实施要点 1"。
- **不把财务页的类名改成通用类名**：改类名会波及财务那四张表的既有断言与样式，
  而本次只需要让**规则**通用，不需要让**页面**统一。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`cd apps/web; npm run test:unit`：｜构建： |
| 权重复核结论（新旧 specificity） |  |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |
