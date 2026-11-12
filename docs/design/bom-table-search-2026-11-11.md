# 生产与采购【BOM 表】加搜索（2026-11-11）

## 1. 用户原话与现状

> 「用户反馈，需要在生产和采购模块的BOM表页面加上搜索功能」

现场盘点（两个入口改的是**同一张** BOM 表，但列表是两份各自渲染的表）：

| 入口 | 文件 | 表实现 | 数据源 | 本轮之前 |
|---|---|---|---|---|
| 采购 → BOM表 | `apps/web/app/procurement/boms/page.tsx` | `DataTable`，5 列（订单号 / BOM状态 / 创建人 / 最后修改人 / BOM表） | `/sales-orders?status=confirmed&page=1&page_size=200` + `/boms` 里的**孤立**行 | 无搜索；只能靠浏览器查找逐屏翻 |
| 生产页【BOM表】面板 | `apps/web/app/production/page.tsx` | **手写** `<table className="data-table table-bounded">`，3 列（订单号 / 数量 / BOM表） | `/sales-orders?status=confirmed&page=1&page_size=200` | 无搜索；**同页**的「生产单查找」有搜索框，所以用户会自然地以为 BOM 表也有 |

数据规模（生产库只读实测，2026-11-11）：未删销售单 55 张（已确认 54 / 草稿 1），未删 BOM 48 张。
结论：这一页的取数上限（200 张）**远没有被摸到**，前端过滤就能覆盖全部数据，不需要新增接口。

## 2. 决策（本轮）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **两个入口都加**搜索框，各自一份状态 | 用户说的就是「生产和采购模块的BOM表页面」；两处是同一份业务的两张脸，只加一处等于把「找单子」这件事变成「看你去哪个模块」 |
| D2 | 匹配语义复用 **`lib/fuzzy-search` 的 `fuzzyMatch`**：空格分词 AND、忽略大小写与空白、空查询不过滤 | 全站所有搜索框都是这一套（供应商 / 物料 / 客户 / 工序 / 单位…）。各页各写 `includes` 就会出现「同一个词在 A 页能搜到、B 页搜不到」，那正是 2026-09-16 那轮搜索治理要消灭的形态 |
| D3 | 只搜**这张表看得见的列**，不去捞后端字段 | 搜出一行、屏幕上却看不出是哪一段命中的，用户会以为搜索坏了。采购页：订单号 + BOM 状态 + 「孤立」徽章；生产页：订单号 + 数量 + 单位 |
| D4 | 状态的**中文标签与后端原值都能命中** | 单元格经 `DataTable` 的 `displayText` 显示成「草稿 / 已确认」，用户照着屏幕上的字去搜；只认 `draft` 就等于让人搜不到自己刚看见的词（生产页「生产单查找」的 KNOWN_DEFECT 正是这个形态，见 §4） |
| D5 | **客户端过滤**，不新增 `/search` 请求 | 数据本来就全量在手（见 §1）；多打一个请求会引入「输入 vs 返回」的竞态，而孤立 BOM 行根本不在 `/sales-orders` 里，服务端搜索只覆盖其中一段 |
| D6 | UI 三件套：`.filter-bar` + 计数条 + **分层空态** | 搜索框的形状要跟全站一致（用户不必为同一件事学两种布局）；计数条是「筛掉了多少」的唯一可见证据；空态要分清「没有匹配」和「真的没有数据」——后者原来那句「暂无已确认销售单 + 还有 N 张草稿」仍然最有用，不能被一句「没有匹配」顶掉 |
| D7 | 生产页**两个搜索框状态不共享**（`query` 给「生产单查找」，`bomQuery` 给【BOM表】） | `query` 还被 `?order_no=` 深链预填；共用一个状态会出现「点了深链，BOM 表也只剩一张单」 |
| D8 | 顺手修掉**同页**两个搜索缺陷（§4） | 它们与本轮改动同源：都是「过滤口径 ≠ 展示口径」。留着的话，新加的搜索框旁边就摆着两个同样难用的搜索框 |

## 3. 搜索字段清单

| 入口 | 可搜字段 | 为什么是这些 |
|---|---|---|
| 采购 → BOM表 | `orderNo`；`status`（原值 `draft/confirmed` + 中文 `草稿/已确认`）；`孤立` | 这三样是这一页屏幕上仅有的「字」。客户名、版本号、创建人 UUID 都在后端但不在屏上，捞进来只会制造「搜到了但看不出为什么」 |
| 生产页【BOM表】 | `orderNo`；`quantity`；`unit` | 手写表只有三列：订单号、数量（含单位）、按钮 |

计数条文案：`共 {全部} 条，当前列出 {命中} 条`（与主数据池同一句式）。

空态文案（有数据但无命中）：

- 采购：`没有匹配“{关键词}”的 BOM 表` / `共 {N} 条，换个关键词或清空搜索框。`
- 生产：`没有匹配“{关键词}”的订单` / `共 {N} 张确认单，换个关键词或清空搜索框。`

## 4. 顺带修复的两个同页缺陷（生产页）

| 缺陷 | 之前 | 现在 | 影响面 |
|---|---|---|---|
| A. 对话框搜索缩小 BOM 表 | `searchSalesOrders()` 把服务端搜索结果写进页面主列表 `orders`，而 `orders` 同时是【BOM表】的数据源 —— 在「新建生产单」对话框里搜一个单号、关掉对话框，BOM 表就只剩被搜到的那几张 | 拆出 `dialogCandidates`：对话框的候选（含服务端搜索）只落它；`orders` 保持全量。`candidateHint`（「有 N 张已确认销售单尚未建立 BOM」）只认全量 | 只影响生产页；建单提交路径不变 |
| B. 中文状态搜不到 | 「生产单查找」用 `` `${productionOrderNo} ${orderNo} ${status}` `` 匹配，`status` 是后端原值 `draft`，而屏幕上显示「草稿」—— 用户照着屏幕输「草稿」得到空表（`test/production-page.test.tsx` 里以 `KNOWN_DEFECT` 钉着） | 换成 `fuzzyMatch(query, [生产单号, 订单号, status, displayText(status)])`，英文与中文都能命中；那条 `KNOWN_DEFECT` 测试改为正向测试 | 只影响生产页「生产单查找」；字段范围不扩大（文案写的就是「生产单、订单号或状态」） |

为什么不另开一轮：这两个缺陷与「BOM 表加搜索」共用同一段过滤代码、同一批测试文件，分开做会在同一处产生两次冲突；而且用户这次的诉求本质是「这一页能搜到我要的单」，缺陷 A 会让**新加的**搜索框在对话框用过一次之后就骗人。

## 5. 刻意不做

| 不做 | 理由 |
|---|---|
| 服务端 `?search=` / 分页搜索 | 见 D5；数据规模不需要（54 张 vs 200 张上限） |
| 按列筛选器（状态下拉 / 版本下拉 / 日期区间） | 用户要的是「搜」；这两张表只有 3–5 列，加筛选器是把简单的事做复杂。真需要时另立需求 |
| 搜索历史、命中高亮、键盘快捷键 | 同上；全站没有先例，先保持一致 |
| 改列名 / 改列宽 / 改表结构 | 与「能搜到」无关；列宽另有守卫（`lib/table-width-coverage.test.mjs`、`lib/bom-table.test.mjs`） |

## 6. 已知边界（登记，不在本轮解决）

| # | 边界 | 说明 |
|---|---|---|
| B1 | 取数上限 200 张 | 已确认销售单超过 200 张时，第 201 张往后的单这一页本来就取不回来 —— 那是**既有的**取数口径（2026-10-13 定的 `page_size=200`），不是搜索引入的。计数条只显示「已加载多少条」，不假装是总数 |
| B2 | 「BOM状态」列在**在册行**上显示的是**销售单**状态 | 在册行来自 `/sales-orders`（`status` = 销售单状态），孤立行来自 `/boms`（`status` = BOM 状态）—— 同一列两种含义。本轮搜索如实跟随屏幕上显示的值（所以搜「已确认」命中的是在册行）。列名/口径该不该改属于业务口径，登记待定 |

## 7. 验证

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit`（web） | 见 §8 终态 |
| `npx vitest run test/procurement-bom-page.test.tsx` | 14/14（含新增 6 例搜索） |
| `npx vitest run test/production-page.test.tsx` | 见 §8 |
| `node --test lib/bom-search-guard.test.mjs`（新增守卫） | 2/2 |
| `npm run test:lib`（web lib 全量，含守卫） | 见 §8 |
| `npm run test:components`（web 组件全量） | 见 §8 |
| `next build` | 见 §8 |

守卫 `lib/bom-search-guard.test.mjs` 钉的是「这类缺口以后不能再出现」：两个入口都必须有 `filter-bar` + 带「搜索」提示的输入框 + `fuzzyMatch`，并且清单里的文件必须真实存在（改名/搬家会立刻变红）。这是**约定守卫**，行为由上面两个组件测试覆盖。

## 8. 终态与实施结果

改动面（4 改 + 3 新增，**纯前端**）：

| 文件 | 改动 |
|---|---|
| `apps/web/app/procurement/boms/page.tsx` | +搜索框（`bom-search`）、计数（`bom-count`）、分层空态；取数/列定义/删除入口未动 |
| `apps/web/app/production/page.tsx` | +【BOM表】搜索框（`production-bom-search`）与计数（`production-bom-count`）；缺陷 A（拆 `dialogCandidates`）与缺陷 B（`displayText` 中文状态 + `fuzzyMatch`） |
| `apps/web/test/procurement-bom-page.test.tsx` | +6 例（新增 `describe(…：搜索（2026-11-11）)`） |
| `apps/web/test/production-page.test.tsx` | +7 例（新 `describe(…：BOM 表搜索（2026-11-11）)`）+ 原 `KNOWN_DEFECT`（中文状态搜不到）改成正向用例 |
| `apps/web/lib/bom-search-guard.test.mjs`（新增） | 约定守卫：两个 BOM 表入口都必须有 `filter-bar` + 带「搜索」提示的输入框 + `fuzzyMatch` + 约定 testid，且清单里的文件真实存在 |
| `docs/design/bom-table-search-2026-11-11.md`、`docs/log/2026-11-11.md`（新增） | 本文与当日日志 |

门禁（终态，全部由 Lead 在收口时重跑过）：

| 检查 | 结果 |
|---|---|
| `npm run typecheck`（api / coding-worker / web） | **exit 0**，三个 workspace 均无错 |
| `npx vitest run test/procurement-bom-page.test.tsx` | **14/14**（原 8 + 新增 6） |
| `npx vitest run test/production-page.test.tsx` | **31/31**（原 24 + 新增 7；`KNOWN_DEFECT` 转为正向用例后仍在） |
| `node --test lib/bom-search-guard.test.mjs` | **2/2** |
| `npm run test:lib --workspace=@dilee/web` | **432/432**（原 430 + 新增守卫 2） |
| `npm run test:components --workspace=@dilee/web` | **75 个文件 / 1312 用例全绿**（本轮新增 13 条） |
| `next build`（web） | **exit 0** |

**反证（证明新测试不是空转）**：实施方在生产页做过三组变异验证，改回旧写法后相应用例立刻变红、恢复后转绿 ——
① 把 `setDialogCandidates` 改回 `setOrders` → 缺陷 A 回归用例红（BOM 表只剩 1 行）；
② 表格渲染改回 `orders.map` → 三条过滤用例红；③ `visible` 改回原来的 `includes` 版本 → 中文状态用例红。
采购侧同类反证由用例设计本身承担：`已确认` 与 `confirmed` 两条断言只有「原值 + 中文标签都喂进匹配」才同时成立，
空格分词用例（`SO 002`）只有 AND 语义才收窄成 1 行（整串 `includes` 或 OR 都会红）。

## 9. 上线影响

- 纯前端改动，**无数据库迁移、无接口变更**。
- 用户可见行为变化三条：① 两个 BOM 表都能按关键词过滤（空格分词 AND、中英文状态都认）；② 列表上多了一条「共 N 条，当前列出 M 条」；③ 生产页「生产单查找」现在能按中文状态搜到，且「新建生产单」对话框里搜过的单号不再影响【BOM表】的显示。

## 10. 未决 / 下一轮

1. B2 的列名与口径（「BOM状态」列在在册行上其实是销售单状态）要不要拆成两列，或改成 BOM 自己的状态 —— 需要业务口径确认。
2. B1 的取数上限：若已确认销售单继续增长，BOM 表入口需要分页或服务端搜索（届时两段数据源都要改）。
3. 生产页「生产单查找」的 `KNOWN_DEFECT`（连点「启动」发两次 POST）与本轮无关，仍在 `test/production-page.test.tsx` 里。
