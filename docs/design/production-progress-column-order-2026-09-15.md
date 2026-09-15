# 生产进度表的工序列顺序由用户拖拽决定（2026-09-15）

> 用户需求原文：「生产模块，导出生产进度表的时候，允许用户拖拽调整各个工序的排序。
> 导出来的生产进度表的工序 column 就按找这个顺序来排序。」

## 1. 现状与问题

生产进度表（`GET /production/reports/production-progress.xlsx?order_no=…`）是「列 = 工序、行 = 生产日期」
的二维矩阵，工序列的先后此前完全由后端决定：

- `materialProductionContext()` 取生产单时 `operations` 按 `sequenceNo asc`（生产单里的工序顺序），
  生产单之间按查询返回顺序拼接；
- `progressSheet()` 把「生产单 × 工序」摊平成列，顺序即上面的拼接顺序。

也就是说：财务/生产想把某道工序排到最前面看，只能改生产单里的工序顺序（那会改动车间实际生产顺序），
或者导出后在 Excel 里手工拖列。

## 2. 决策

- **D1：列顺序是「导出显示偏好」，不是生产顺序。** 不去改 `production_order_operations.sequence_no`
  —— 那是车间实际生产先后，把偏好写回它，等于把「我想按这个顺序看表」变成「这道工序要排到那时候做」。
- **D2：顺序随导出请求走。** 前端把它作为 `operation_order`（逗号分隔的工序 id）传给导出接口，
  后端只按它排表头；不新增表、不改状态机。
- **D3：按订单号记在这台机器上（localStorage）。** 与面板折叠状态（`lib/collapsible-panel.ts`）同一套做法：
  拖一次就记住，下次打开还在；不需要迁移，也不引入「谁的偏好才算数」的多人冲突。
  换机器/换浏览器会回到默认顺序 —— 可接受，因为这是显示偏好而不是业务事实。
- **D4：没提到的工序按原相对顺序排在后面。** 存过的顺序里若少了后来新增（或当时被过滤掉）的工序，
  那些工序不能从表里消失，只是排在后面。
- **D5：只有生产进度表认这个参数。** 单独一个 `ProgressExportDto`：原料对应表/订单号盘点表收到
  `operation_order` 会按白名单 400 —— 好过「传了但被静默忽略」，那种沉默会让人以为列序生效了。

## 3. 实现

### 后端

| 位置 | 改动 |
| --- | --- |
| `production-progress-columns.domain.ts`（新） | `parseOperationOrder(raw, max=200)`：逗号分隔、去空白、去重、截断；`orderProgressColumns(columns, order)`：按顺序重排，没提到的接在后面 |
| `production-payroll-export.controller.ts` | 新增 `ProgressExportDto { order_no, operation_order? }`（只给生产进度表路由） |
| `production-payroll-export.service.ts` | `exportProductionProgress(filters)` 解析顺序传给 `progressSheet(..., operationOrder)`；`progressSheet` 在摊平成列后调用 `orderProgressColumns`；导出元信息在用了自定义顺序时记录 `operation_order`（拿到文件的人能看出列序是人工调过的） |

数量口径完全不变：只重排 `columns` 数组，目标数量行、加工地点行、每日完成数量与表尾合计都跟着同一批
列一起走，因此不存在「列换了位、数字没跟着」的风险。

### 前端

| 位置 | 改动 |
| --- | --- |
| `lib/progress-column-order.ts`（新，纯逻辑） | `progressColumnOrderKey` / `parseStoredColumnOrder` / `serializeColumnOrder` / `moveColumn` / `applyColumnOrder` / `isDefaultColumnOrder` |
| `components/production/progress-column-order-editor.tsx`（新） | 可拖拽行（原生 HTML5 DnD，不引依赖）+ 上移/下移按钮（触屏、键盘、自动化测试都靠它）+ 恢复默认顺序；行首显示序号，拖拽中的行有可见反馈 |
| `components/production/payroll-export-panel.tsx` | 生产进度表弹窗内嵌该编辑器；选订单时从 localStorage 读回顺序、变更时写回；导出时只有**顺序真的变了**才带 `operation_order`（URL 保持干净） |

前端与后端各有一份 `applyColumnOrder` 同口径实现（不同运行时，各自带测试），规则在注释里互相指向。

## 4. 验证

见 `docs/log/2026-09-15.md` 的「第四轮」段落。

## 5. 未验证与已知边界

- **未在浏览器里实际拖过**：DnD 的自动化覆盖是 jsdom 下的 `dragstart/dragover/drop`（并且必须显式传
  `dataTransfer` 才能触发 React 的拖拽事件），真实浏览器的拖拽手感、拖拽指示与触屏行为需要在页面上确认；
- **未在真实 PostgreSQL 上跑过导出**（本机无可用库）：`exportProductionProgress` 的真实 SQL 与新参数
  的鉴权/白名单行为待端到端验证；
- 顺序是**本机**偏好：换机器、换浏览器、清缓存都会回到默认顺序；若以后要「全公司统一列序」，
  应做成字典或按订单保存的服务端偏好（本次刻意不引入这个复杂度）。
