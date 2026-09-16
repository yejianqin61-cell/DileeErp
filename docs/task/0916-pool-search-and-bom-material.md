# 任务：池子搜索 + BOM 表的「新建物料」

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

1. 「供应商池，要支持搜索。」
2. 「所有池子，都要支持搜索」
3. 「BOM表的新建物料按钮怎么不见了。」

用户选择：第 1、2 条**只做池页面上的搜索框**（表单里的下拉本轮不动）；
第 3 条**三处入口都恢复成真能用的**。

设计见 [池子搜索与 BOM 表的「新建物料」](../../design/pool-search-and-bom-material-create-2026-09-16.md)。

## 目标

- 全站 9 个「池」页面都能按关键字搜索，且匹配语义完全一致（多词 AND、忽略大小写与空白）；
- BOM 表在三个入口（采购→BOM表、采购单→编辑BOM表、生产→BOM表）都能就地新建物料并回填当前行。

## 关联决策

- 匹配规则只留一份实现（`lib/fuzzy-search.ts`），池子不再各写一句 `includes`；
- 搜索框要配计数与「搜不到」空态（点名关键词 + 总数），否则用户搜错一个字会以为池子是空的；
- 「新建物料」只有一份表单（共享组件），物料清单页与 BOM 工作区共用，避免字段漂移；
- 新物料必须先进页面的物料池再回填：BOM 行的物料下拉是按 options 渲染名字的，只填 id 会变空白。

## 范围与非范围

**做**：

- `lib/material-search.ts` → `lib/fuzzy-search.ts`（改名 + 更新唯一使用者），新增池子搜索守卫；
- 补搜索框：供应商池、物料清单（物料池）、客户池（销售页，`/customers` 复用同一页面）；
- 统一到 `fuzzyMatch`：工序池 / 加工地点池（顺带补齐筛选条与计数）、单位池、部门池 / 岗位池、银行账户池；
- 新增 `components/bom/material-create-dialog.tsx` 并在三处 BOM 入口接线；
- 采购单页补回丢失的「编辑BOM表」入口（改前 `openBom()` 无任何调用方，BOM 工作区不可达）；
- 物料清单页改用共享的「新建物料」弹窗，删掉自己那份重复实现。

**不做**：

- 表单里的下拉不做成可搜索下拉（用户本轮明确选择只做池页面）；
- 员工目录（人事）的过滤语义不并入（该文件正由另一个 agent 修改）；
- 不做后端搜索/分页：池子是一次性拉全后前端过滤，几千条以上时再改。

## 验收与验证

1. `test/pool-search.test.tsx`（13 条）：三个池子的搜索框在 DOM 里、命中编码/名称/联系人/电话/
   规格型号/颜色/单位名/国家地区、多词 AND、搜不到时的空态与计数、清空后恢复；
2. `test/material-create-dialog.test.tsx`（6 条）：POST `/materials` 的精确 body（空串字段必须消失）、
   手动编码、默认单位必填、失败时弹窗保持打开、新增类目 → 新建单位 → 回填并保留已填字段、
   新建单位失败时停在单位表单；
3. `test/procurement-bom-page.test.tsx`（2 条）：采购→BOM表 点「新建物料」建完回填当前行并随
   PUT `/boms/:id/items` 发出 `material_id`/规格型号/颜色；失败时不动 BOM、不发保存请求；
4. `test/production-page.test.tsx`（24 条，+1）：生产页的 BOM 工作区同样能新建物料并回填；
5. `test/procurement-draft.test.tsx`（8 条，+2）：采购单草稿选中 BOM 后可「编辑BOM表」并看到
   「新建物料」，未选 BOM 时入口禁用；
6. `lib/pool-search-guard.test.mjs`（2 条）：每个池页面都有搜索框且走统一语义 + 池子清单不漏登记；
7. `lib/fuzzy-search.test.mjs`（7 条，原 `material-search` 用例，改名后语义不变）。

## 决策记录

- **统一语义而不是只补三个搜索框**：单字查询下两种实现看不出差别，但「香港 迪礼」这种多词查询
  结果不同；统一之后用户在任何一个池子里学到的搜索行为都成立。
- **反向守卫**：除了「清单里的池子必须有搜索框」，还检查「任何把『池』写进界面文案的文件都必须在清单里」，
  否则新增池子时漏加搜索框只能等用户来发现。
- **物料类型按界面说法参与搜索**（搜「成品」能命中 `finished_product`），因为用户脑子里的词是界面上的词。
- **默认单位按名字参与搜索**（物料表里存的是单位 id）。
- **共享弹窗用 `key` 强制换实例**：`ActionDialog` 按字段名保留已填值，两个表单都有 `name` 字段，
  不换实例会让「新建单位」的名称框带上物料名（实测拼成「伞骨打」）。
- **`keepOpenRef` 吃掉提交成功后的那次 `onOpenChange(false)`**：那次不是用户关窗，否则刚建好的
  单位选中态与整份物料草稿会被清掉。
- **采购单页补回「编辑BOM表」按钮**：不补的话，给 `onCreateMaterial` 接线也没有意义
  （整个工作区在那一页不可达）。

## 完成记录

- 新增：`apps/web/lib/fuzzy-search.ts`（改名自 `material-search.ts`）、
  `apps/web/lib/pool-search-guard.test.mjs`、`apps/web/components/bom/material-create-dialog.tsx`、
  `apps/web/test/{pool-search,material-create-dialog,procurement-bom-page}.test.tsx`；
- 修改：`app/procurement/{suppliers,materials,boms,orders}/page.tsx`、`app/sales/page.tsx`、
  `app/production/page.tsx`、`app/warehouse/raw-material-storage/page.tsx`（改 import）、
  `components/production/{master-data-pool-page,unit-pool-page}.tsx`、
  `components/hr/organization-pool.tsx`、`components/finance/bank-workspace.tsx`、
  `test/{production-page,procurement-draft}.test.tsx`；
- 验证：web 组件 **41 文件 / 756 用例**全绿、web lib **156 条**全绿、`tsc --noEmit` 通过。
  **本轮没有后端改动**，因此未跑 API 单测；搜索是前端过滤。
