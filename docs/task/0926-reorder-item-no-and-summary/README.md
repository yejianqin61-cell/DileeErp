# 0926 销售单货号 + 返单与总结（任务批次）

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md)
> 用户原话：「分步实现，根据这份决策文档，拆解出一批可直接依据开发的子任务 task 文档先」

## 批次目标

老板要求：每个销售单多一个**货号**字段；客户返单时货号不变、从系统里调取；按货号能调出**当时那批**的
采购、生产、QC 全部表单；左侧新增一个 **「返单与总结」** tab。

已拍板口径（不得在实现中擅自改变，要改先改设计文档）：

1. **货号挂在销售单这一层**（单头一个货号），明细行的「品番/品名」保持现状。
2. **不建货号主数据表**：货号清单从销售单投影，编辑器下拉喂既有货号、可输新货号。
3. 返单**全带工艺口径**（37 标量 + 明细 + 材料引用），数量/下单日/交期必须重填，单价照带但标「待复核」。

## 任务清单

| # | 任务 | 期 | 依赖 | 交付面 | 可并行 |
| --- | --- | --- | --- | --- | --- |
| [01](./01-sales-order-item-no-schema.md) | 货号字段：数据层迁移 | P1 | — | prisma | 与 10、13 并行 |
| [02](./02-sales-order-item-no-api.md) | 货号字段：写读侧与归一 | P1 | 01 | api/sales | 与 10、13 并行 |
| [03](./03-item-no-on-printing-exports.md) | 货号印上工艺单与采购单打印表 | P1 | 01,02 | api/sales + api/procurement | 与 04 并行 |
| [04](./04-sales-order-item-no-web.md) | 销售单前端：货号录入、列表列与筛选 | P1 | 01,02 | web | 与 03 并行 |
| [05](./05-reorder-create-service.md) | 返单建单：服务端复制语义与预览 | P2 | 01,02 | api/sales | — |
| [06](./06-reorder-web-entry.md) | 返单前端：入口、预填与来源提示 | P2 | 04,05 | web | — |
| [07](./07-reorder-articles-api.md) | 货号清单接口（新模块骨架） | P3 | 01,02 | api/reorder | 与 10 并行 |
| [08](./08-reorder-article-detail-api.md) | 货号详情：批次序列与跨批汇总 | P3 | 07 | api/reorder | — |
| [09](./09-reorder-documents-and-timeline-api.md) | 单据清单与时间线接口 | P3 | 08 | api/reorder | — |
| [10](./10-reorder-nav-and-permission.md) | 导航 tab 与表面权限栏目 | P3 | — | api/platform + web | 与 01、07 并行 |
| [11](./11-reorder-page.md) | `/reorder` 页面 | P3 | 07,08,09,10 | web | — |
| [12](./12-reorder-history-backfill.md) | 历史单未填货号补录 | P3.5 | 07,11 | web + api/sales | — |
| [13](./13-order-no-deeplink-procurement.md) | 采购页 `?order_no=` 深链补口 | 独立 | — | web | 随时 |
| [14](./14-reorder-summary-enhancement.md) | 复盘增强：毛利/交期达成/合格率趋势/导出 | P4 | 07,08,09 | api/reorder + web | 观察一轮后再做 |
| [15](./15-docs-and-close.md) | 文档收口（每期都要做一遍） | 每期 | 该期全部 | docs | — |

## 建议执行顺序与提交节奏

```
P1  : 01 → 02 → (03 ∥ 04) → 15          ← 可单独上线：货号只是多了一列，旧流程零影响
P2  : 05 → 06 → 15                       ← 依赖 P1 的 04
P3  : 10 ∥ 07 → 08 → 09 → 11 → 12 → 15   ← 13 可插在任何空档
P4  : 14 → 15                            ← 观察一轮汇总口径被业务确认后再动
```

一个任务一个提交，消息前缀 `feat(sales)` / `feat(reorder)` / `feat(web)` / `docs` / `fix`。
**提交必须带显式 pathspec**（`git commit -m "…" -- <paths>`）——同一工作树里有其它工作流在跑财务模块，
`git add -A` 会把别人的半成品带进历史。

## 全批次通用规矩

**验证命令**（与本仓库既有口径一致，不要自创）：

| 检查 | 命令 | 说明 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 根目录，api + web |
| API 单测 | `npm run test:unit:api` | 内部先 `nest build` 再 `node --test`；**改了 API 必须走这条**，直接跑 `node --test` 会读到过期 `dist` |
| Web 单测 | `cd apps/web; npm run test:unit` | = `test:lib`（`node --test lib/**/*.test.mjs`）+ `test:components`（vitest） |
| 部署脚本 | `npm run test:deploy` | 只在动了 `scripts/` 时相关 |
| http / integration / e2e | `npm run test:api` / `test:integration` / `test:e2e` | **需要真实 PostgreSQL 与已启动的 API**；本机通常没有，跑不了就在「完成记录」里写明「环境阻断」，不要假装跑过 |

**口径红线**（跨越每个任务）：

- 数量**不跨单位合计**、金额**不跨币种合计**：一律按单位/币种分行返回数组。
- Decimal 一律**字符串**出口，日期一律 ISO 字符串；前端不重算业务余额。
- 软删记录默认排除，可通过显式开关包含；**已关闭（closed）订单纳入统计**（返单看的是历史经营事实）。
- 北京时间统一走 `apps/web/lib/audit-time`（不要用 `toLocaleString`）。
- 货号**存原样展示、按归一键匹配/分组**（`itemNoKey` = trim + 折叠空白 + 大写）。
- 不引入原生浏览器控件（`datalist`/`window.confirm` 等）——全站治理轮已明确移除。

**批次不做的事**（明确在范围外，避免实现者顺手扩面）：

- 不建货号主数据表、不给货号加图片/负责人/停用状态。
- **不把货号冗余到采购/生产/QC 等下游表**（下游只冗余 `order_no`，货号走订单号集合反查）。
- 不做货号的审批流、不做返单的自动建 BOM/采购/生产（返单只到「新建销售单草稿」为止）。

## 完成判定

1. 15 个任务文档里的「验收与验证」逐条可对照；每个任务的「完成记录」写了实际命令与结果。
2. P1 上线后旧流程零回归：不带货号的销售单创建/编辑/确认/导出全部与改造前一致。
3. 按货号能查到该货号**每一批**的采购 → 到货 → 来料质检 → 原料入库 → 生产 → 领料 → 日报 → 成品送检 →
   QC → 成品入库 → 次品 → 出库 → 应收应付，且单号/数量/状态与各模块页面一致（§八 验收第 4 条）。
4. 「以此返单」产出的新单：货号与来源单一致、来源可追溯、老单及其下游事实**零改动**。
5. 设计文档的「实施结果」节按实际填写，与本文档的完成记录不互相矛盾。
