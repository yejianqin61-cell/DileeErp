# 采购订单导出收列 + BOM 物料下拉可搜索（2026-10-13，第四轮）

## 来源需求（用户原话）

1. 「采购部分，采购订单导出时，那个 excel 表单里面，可以不用有供应商这一个 column。采购单号这个字段也不需要导出。交货日期也不需要这个 column」
2. 「建立BOM表的页面，生产和采购都是，在添加行，选择物料的时候，要支持搜索功能，搜索物料清单里面的」

追问一轮后的口径（用户选「两个都保留（推荐）」）：第 1 条删除的**只是明细表里的「供应商」列与「交货日期」列**，
以及表头那一格「采购单号：」；抬头里的「供应商名称：」与「交货日期：」**保留**
（厂商要知道这张单开给谁、整单哪天要）。

---

## 一、采购订单导出：明细 9 列 → 7 列，表头 12 格 → 11 格

改动全在 `apps/api/src/modules/procurement/purchase-order-export.service.ts`（打印件就是「那个 excel 表单」：
标题 / 交货地址 / 表头字段网格 / 明细表 / 小计 / 备注 / 交易条款 / 签署栏）。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 明细表列 | 序号 / 产品名称 / 规格型号 / 单位 / **供应商** / 含税单价 / 数量 / 含税总价 / **交货日期** | 序号 / 产品名称 / 规格型号 / 单位 / 含税单价 / 数量 / 含税总价 |
| 表头字段网格 | 4 行 × 3 组 = **12 格**（末格「采购单号：」） | 同布局，实填 **11 格**（第 4 行只剩「付款方式 / 电话」，右端一格留空） |
| 抬头保留 | — | 「供应商名称：」「交货日期：」都留（用户确认） |

四个容易漏的点，逐个处理：

1. **两个字段是"整条链路"删掉的**，不是打印时跳过：`PurchaseOrderDocumentLine` 上的 `supplierName` /
   `deliveryDate` 与 `ExportItem.supplier` 都删了，明细 include 里也不再 join 每行的供应商
   （留着没人读的字段，下一个人会以为那一列还在）。
2. **小计公式跟着列走**：含税总价从第 8 列（H）变成第 7 列（G），公式列**由 `COLUMNS` 推出来**
   （`findIndex(header === "含税总价")`）而不是写死 `SUM(H…:H…)` —— 写死的 H 会指向一个空列，
   纸面上小计变成 0，而且不会有任何测试以外的报错。
3. **版心宽度与明细表宽度从此不是一回事**：表头字段网格是 3 组「标签 + 跨两列的值」，天然占 A:I 九列，
   与明细表有几列无关。所以 `LAST_COLUMN` 拆成两个概念：
   - `SHEET_LAST_COLUMN = "I"`：标题 / 交货地址 / 交期条款 / 备注 / 签署栏这些整行合并的右边界；
   - 明细表最后一列直接用 `COLUMNS.length`（循环与公式都按它走）。
   若仍共用一个常量：表头第三组的值格（H:I）会落到列定义之外，或者整行文本莫名缩到 G。
   随之补上 `HEADER_GRID_TAIL_WIDTHS = [12, 14]`：H/I 不再是明细列，但仍要给宽度，
   否则「供应商名称 / 下单录入时间 / 电话」这几个值会被挤进默认宽度（8.43 字符）里。
4. **第 4 行那格空位不重排**：这 12 格的位置是用户 2026-09-16 逐项点名的顺序，重排会让一张已确认过的
   单子换个样子；空着的位置纸面上看不出来（没有标签、也没有值格边框）。理由写在 `HEADER_GRID_START` 注释里。

**采购单号仍留在 `PurchaseOrderDocument` 上**，但只用于**工作表名**（批量导出 = 一簿多单，表名认单）。
工作表名不打印、不进纸面，所以「不给厂商看采购单号」与「导出时仍分得清哪张是哪张」两件事不冲突 ——
这条判断写进了 `purchaseOrderNo` 字段的注释，测试里也钉了「纸面上任何一格都不出现它」。

## 二、BOM 物料下拉：Radix Select → SearchableSelect

`apps/web/components/bom/bom-workbench.tsx` 的物料名称单元格换成全站既有的 `SearchableSelect`
（会计科目 / 供应商 / 销售单物料引用都在用它）。生产与采购共用这一个组件，**一处生效两处**：

| 入口 | 组件 | 改后 |
| --- | --- | --- |
| 采购 → BOM表 | `app/procurement/boms/page.tsx` | 可搜索 |
| 采购单 → 编辑BOM表 | 同组件 | 可搜索 |
| 生产 → BOM表 | `app/production/page.tsx` | 可搜索（`showSupplier=false` / `showReferencePrice=false` 只影响那两列） |

为什么这次不是"多写一个搜索框"：物料池是**全量**下发的（`GET /materials` 无分页、无 `page_size`，
见 `procurement-master-data.service.ts:84`），所以搜索是前端过滤就能解决的事，不需要动接口；
反过来说，池子几百条时"只能在长列表里滚"才是真问题 —— 与 2026-09-16 那轮「池子加搜索」同源，
当时用户明确选了「只做池页面」，表单里的下拉留到了今天。

三处配套：

1. `components/ui/searchable-select.tsx` 新增可选 `title`：省略号发生在**触发器**里，
   所以 title 挂在触发器按钮上（不是根 div —— 展开后根 div 里是搜索框，挂那儿会弹出与当前内容无关的气泡）。
   物料列 20% 宽 + 长物料名，被吃掉的字必须有地方 hover（2026-10-08 用户的要求，守卫在 `lib/bom-table.test.mjs`）。
2. **CSS 一行没改、也不能改**：`.bom-table .bom-col-material .ui-select-trigger` 那两条省略号规则
   继续生效，因为两种下拉的触发器都带 `.ui-select-trigger` 类（`SearchableSelect` 额外多一个
   `.ui-searchable-select-trigger`）。守卫里写明：谁把它收窄成某一种实现的类名，省略号当天静默失效。
3. 新增 `.bom-table .bom-col-material .ui-searchable-select-popover { min-width: 320px; }`：
   弹层默认 `left:0/right:0` = 跟列同宽（表最小宽 1180px 时 ≈236px），几十个字的物料名会折成三行。
   物料列是第 2 列，320px 的弹层离表右边界还有 800px 以上，不会把 `.table-wrap` 的横向滚动撑出来。

## 三、测试

| 文件 | 改动 |
| --- | --- |
| `apps/api/test/purchase-order-export.test.cjs` | 表头用例改 11 格 + **反向断言**（`采购单号：` 不在、`PO-…` 不出现在任何一格）；明细用例改 7 列；新增「明细不再印供应商与交货日期」一条（断言第二个供应商名与明细行日期都不出现、而抬头那两句仍在）；小计断言改 `SUM(G…:G…)` 且数量列不求和 |
| `apps/web/test/bom-workbench.test.tsx` | 物料列的 4 个旧用例改用「进根 div 找 combobox」；新增 describe「物料名称列支持搜索（4 条）」：按关键字收窄候选、选中后值进保存体、生产侧入口同样能搜、搜不到时指路物料清单 |
| `apps/web/test/searchable-select-interaction.test.tsx` | 新增 1 条：`title` 落在触发器上、不传则无该属性 |
| `apps/web/test/procurement-bom-page.test.tsx`、`production-page.test.tsx` | 弹窗里的「物料名称」输入框改为**在弹窗内**查询：BOM 行那个可搜索下拉的可访问名也叫「物料名称」，全局查会撞两个 |
| `apps/web/lib/bom-table.test.mjs` | 物料列守卫加两条：那一格必须用 `SearchableSelect` 渲染 + 搜索文案点明按编码/名称搜；新增一条弹层宽度守卫 |

修的是**测试的取法**而不是断言（`getByLabelText` 撞两个是页面上真的多了个同名控件），
没有把任何一条业务断言放宽。

## 四、上线与风险

- **本轮无迁移、无接口变更**：只改了导出版式与一个前端下拉实现，前后端可独立部署。
- `docs/samples/采购订单-样例.xlsx` 已按新列重新生成（`scripts/make-export-samples.cjs` 的采购单部分；
  该脚本的领料/补料部分因为 `MaterialSlipExportService` 现在多要一个 actors 服务而跑不通，**未动**）。
- 已知缺口（未做）：单位下拉仍不可搜索（单位池小，用户没提）；`docs/samples` 里另两个样例仍是 2026-09-11 的旧版。
