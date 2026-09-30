# 销售板块二级页、引用物料的导出兜底与明细自定义列名（2026-09-30）

用户原话（五件事一起提的）：

> 1. 成品出库总览，客户池，销售单，都收进二级页面。
> 2. 新建销售单，材料明细那边，如果是使用引用的资料，在导出的 excel 中无法显示。
> 3. 材料明细，引用的下拉列表也支持搜索。
> 4. 细分明细那边，可以改成自定义字段名称。
> 5. 销售单导出的部分，工艺要求那边，每一点的标题也需要显示。

范围：`apps/web` 的销售页与销售单编辑器、`apps/api` 的销售单导出与销售单服务；
一条新迁移 `20260930120000_sales_order_spec_detail_labels`。

---

## 一、销售页拆成「一级卡片 + 三个二级页」

### 现状与问题

改造前 `apps/web/app/sales/page.tsx` 是**一页三板块**（成品出库总览 / 客户池 / 销售单），
一次要发三个请求（`/customers?page_size=200`、`/sales-orders?page_size=200`、
`/sales-orders/finished-goods-summary`）。销售每天只看其中一张表，却要等另外两次请求；
三个板块共用一个错误态与一个加载态，地址也没法直接指向「销售单列表」发给同事。

### 做法：照财务那一套（一级选板块、二级看一张表）

| 路由 | 内容 | 页面根 testid |
|---|---|---|
| `/sales` | 三张卡片入口（纯导航页，**不发任何业务请求**） | `page-sales` |
| `/sales/finished-goods` | 成品出库总览 | `page-sales-finished-goods` |
| `/sales/customers` | 客户池 | `page-sales-customers` |
| `/sales/orders` | 销售单列表（含详情 Sheet、出库通知、工艺单导出） | `page-sales-orders` |

- 板块清单只有一份：`apps/web/lib/sales-sections.ts`（纯数据模块，与 `lib/finance-sections.ts` 同一条理由 ——
  卡片上的名字与页面标题不许各写一份）。
- 三个板块的实现搬进 `components/sales/{finished-goods-overview,customer-pool,sales-orders-list}.tsx`，
  **行为与 testid 一字未改**（`sales-order-new` / `order-edit-*` / `order-production-sheet-*` /
  `sales-item-no-filter` / `customer-search` / `customer-count` 等全部保留）。
- `/customers` 仍存在，且渲染**同一个** `CustomerPool`：`/sales/customers` 与 `/customers` 属于两个不同的
  表面栏目（`sales` 与 `customers`，见 `lib/surface-permission.ts`），谁被授权进哪一页由后端决定。
  口径只有一份，页面根 testid 按路由走。
- 拆页之后**每一页只拉自己那一个接口**，这条被测试钉住（`test/sales-subpages.test.tsx`）——
  否则「拆了页却还在一次拉三个接口」等于白拆。
- 销售单编辑器保存/取消/返单失败后的返回目标从 `/sales` 改成 `/sales/orders`：销售存完单要去处理下一张，
  回一级卡片页是绕路。

### 刻意不做

- **不做标签页**（一个页面里切三个板块）：那样三个接口还得一起拉，地址也不能指向某一个板块。
- **不在一级页保留「新建销售单 / 新建客户」按钮**：它们各自属于一个二级页，放在卡片页会出现
  「在总览页点新建客户」这种说不清的入口。
- **不动左侧导航**：`/sales/orders` 下左侧「客户与销售」不会高亮 —— 这是全站既有行为
  （`/finance/*`、`/procurement/*` 都一样），改它属于导航层统一改造，不在本轮。

---

## 二、引用了物料的材料明细，导出必须印得出来

### 现场问题

「新建销售单，材料明细那边，如果是使用引用的资料，在导出的 excel 中无法显示。」

### 根因

「格子里印什么文字」与「这一格引用了哪个物料」是**两条独立的记录**：

| | 存在哪 | 谁写 |
|---|---|---|
| 格子的文字 | `sales_orders.rib_spec` 这类标量列（`SPEC_SCALAR_FIELDS`） | 引用时前端顺手写进去（`materialSpecText`），之后人还可以改 |
| 这一格引用了谁 | `sales_order_material_refs` 一行 | 选中物料时 |

导出原来的写法是「只印有值的行」（`materialLines.filter((line) => line.value)`）——
**文字那条为空时，这个盘位整行都不印**：引用了物料这件事在纸上彻底消失，
工厂拿到一张少了一个部件的工艺单，而系统里那格明明"有东西"。

### 修法（两层，缺一不可）

1. **导出侧兜底**（`sales-order-export.service.ts`）：格子里有人写的字就印字；
   **字为空但引用了物料**时，用引用的物料生成文字 —— `materialRefText(material)` =
   `物料编码 + 名称 + 规格型号 + 颜色`（空的段不留空格）。带上编码是因为这一行是给车间/工厂看的，
   编码是唯一能在【采购 → 物料清单】里查到的标识。
2. **不改「空盘位自动省略」**：既没文字也没引用的栏位仍然整行不印（这条用户口径没变）。

图片那一侧（表尾图片区、勾选弹窗）本来就读 `material_refs`，不受影响。

### 刻意不做

- **不做「保存时把引用的物料文字补回格子里」**：那会覆盖用户对格子的真实编辑
  （用户把字删空是一个明确动作），把"导出能印出来"这件事做成"顺手改了用户的数据"。
- **不在导出件上标「这行是兜底来的」**：纸上多一句系统话，对工厂没有用；
  兜底文字里带了物料编码，已经足够让人对回物料清单。

---

## 三、材料明细的引用下拉支持搜索

改造前是一个平铺的 Radix `Select`（几百条物料就靠肉眼翻），
现在换成全站既有的搜索下拉原语 `components/ui/searchable-select.tsx`
（应收账款科目、工资科目等在用，过滤语义 = label 与 value 都按子串命中、忽略大小写）。

- 选项 label = `物料编码 / 名称 规格型号 颜色`（`materialOptionLabel`），
  所以**按编码、名称、规格、颜色都能搜到**；搜不到时给可读空态
  「没有匹配的物料（可到【采购 → 物料清单】新建）」，而不是一片空白。
- **不另造一个搜索下拉**：过滤语义只该有一处实现。
- 与 `ui/select` 的差别写在使用处：SearchableSelect 收起态是 `button`、展开态换成搜索框，
  testid 在**根 div** 上（点击根 div 不展开）—— 用例要点它里面的 `combobox`。

---

## 四、细分明细的列名可以按单改

### 数据

`sales_orders.spec_detail_labels JSONB NOT NULL DEFAULT '{}'`（迁移 `20260930120000`）。

为什么是**一个 JSON 列、不是 6 个列**：这 6 个名字纯粹是"印在纸上的显示名"，
不参与校验、不参与任何金额/数量计算。为显示名加 6 列会把这行再推宽 6 格，
而默认值本来就该在代码里。

为什么 **NOT NULL DEFAULT '{}'**：空对象 = 全部用默认列名。这样读侧不必处理
「SQL NULL 与 JSON null」两种空（Prisma 的 `Json?` 在这一点上有真实的坑）；
Postgres 11+ 加带默认值的 NOT NULL 列不重写全表，真实库上是秒级。

为什么**按单存、不做全局字典**：同一张单的不同分组列名本来就不同 ——
模板样本 `DL260001-1` 的「伞布明细」与「伞头配色」两块表头就不一样，
而用户要的是"这一单按我写的印"。

### 清单只有一个真源（每侧一份，靠测试对齐）

| 侧 | 常量 | 用途 |
|---|---|---|
| 后端 | `SPEC_DETAIL_LABELS`（`sales-orders.service.ts`） | 归一、默认名、导出 |
| 前端 | `SPEC_DETAIL_COLUMNS`（`lib/sales-order-spec.ts`） | 表头、改列名弹窗、载荷 |

两个 workspace 之间没有共享包，所以各有一份；`SPEC_DETAIL_LABELS` 的键**取自**
`SPEC_DETAIL_COLUMNS` 的同一顺序，且两边的默认名由测试逐键钉住。

### 规则

- 键只能是那 6 列；**不认识就报错**（`SPEC_DETAIL_LABEL_KEY_UNSUPPORTED`），不静默忽略 ——
  静默忽略的表现是「界面上改了名字、导出还是老名字」，那种错没人能查。
- 列名 ≤ **20 字**（`SPEC_DETAIL_LABEL_MAX_LENGTH`，超出 → `SPEC_DETAIL_LABEL_TOO_LONG`）：
  表头要印在一格里。前端也在保存前拦一次（不让用户等一个来回）。
- **空串 = 这一列用默认名**（"恢复默认"必须表达得出来）；载荷是**整块替换**语义
  （不传 = 不动，传 `{}` = 全部恢复默认），与 `material_refs` / `spec_details` 一致。
- 进**版本快照**（当前值打底、请求值覆盖）：回看某个版本时要能回答"那一版的工艺单表头印的是什么"。
- **返单沿用来源单的列名**（没有自己带的话）：列名属于"上一批的工艺口径"的一部分。

### 落在纸上

明细表头的「品番/品名 / 颜色 / 条码 / 数量 / 单位」跟着这一单改；
「图片」列**不是**明细字段，列名固定。

⚠️ 一处**有意的默认值统一**：导出件里那一格的默认名原来是短写的「颜色」，
而编辑页上一直写的是「颜色/配色」。列名既然可以按单改了，"页面显示的名字"与"印出来的名字"
就必须是同一份 —— 所以导出改用 `SPEC_DETAIL_LABELS` 的默认名，那一格从「颜色」变成「颜色/配色」。
这不是顺手的改写，是"列名只有一个真源"的必然结果，已写进测试注释。

### 刻意不做

- **不做"逐分组各一套列名"**：模板样本里两块明细的表头确实不同，那需要把列名存到
  `sales_order_spec_details` 的分组上（或另建一张分组表）。用户这次要的是"这一单按我写的印"，
  先按单存一套；按分组存是下一步，届时 `spec_detail_labels` 的形状要按分组升级（有迁移）。
- **不做"点表头就地编辑"**：6 个名字是一起看的（「品番/品名」与「颜色/配色」是同一张表的列），
  逐列弹窗只会让人漏改两格，而漏改的表现是"导出里一半新名、一半旧名"。
- **不把 `spec_detail_labels` 写进数据字典**：数据字典本来就不收销售单那 37 个细化字段与
  `spec_details` / `material_refs`（见 `docs/data-dictionary.md` 第 3.2 节），
  单独为这一列补一行会让字典看起来"收全了"，反而误导。

---

## 五、工艺要求每一点带标题

改造前导出的是 `1.<内容>`：看纸上的人得自己猜这一条是"样品要求"还是"裁布要求"。
现在落格是 `序号.栏位中文名：内容`，例如：

```
1.样品要求：大货样：每个设计各1支
2.裁布要求：小裁要求：4层
```

- 编号仍然**只给有值的条目**、从 1 连续（跳过的条目不留断号）。
- 文档形状 `ProductionSheetDocument.processLines` 从 `string[]` 改成
  `Array<{ label, value }>`：标题是**数据**，不是渲染时现拼的字符串，测试与后续按标题取值都靠它。
- 内容里本来就可能自带标题（样本里手写的「产前样：各色1支」），会出现两个冒号 ——
  这是**保留用户原话**的代价，比"猜哪个冒号是标题、把它删掉"安全得多。

---

## 六、验证

| 套件 | 结果 |
|---|---|
| API 单测 | **2231/2231**（新增：明细列名 18、导出兜底/工艺标题若干、DTO 2） |
| web lib | **289/289**（新增：列名纯函数 5） |
| web 组件 | **1020/1020**（60 文件；新增：销售二级页 5、明细列名 4、引用下拉搜索 1） |
| `typecheck`（api + web） | 干净 |
| `test:deploy` | 32/32 |

新增测试文件：`apps/api/test/unit/sales-order-spec-detail-labels.test.cjs`、
`apps/web/test/sales-subpages.test.tsx`。

迁移与 Prisma DDL 的一致性：`prisma migrate diff --from-empty` 生成的
`"spec_detail_labels" JSONB NOT NULL DEFAULT '{}'` 与手写迁移逐字一致；
`apps/api/test/unit/sales-order-spec-detail-labels.test.cjs` 另有一条守卫盯住
「JSONB + NOT NULL DEFAULT '{}' + 不建索引 + 不删结构 + 不改写数据」。

## 七、遗留与已知缺口

1. **成品情况接口失败时，销售单详情 Sheet 会永久停在「正在加载成品情况…」**（既有 KNOWN_DEFECT，
   本轮只是把代码从 `app/sales/page.tsx` 原样搬进 `components/sales/sales-orders-list.tsx`，
   行为与责任行号同步更新在 `test/outbound-notice-pages.test.tsx`）。
2. **明细列名按单一套**（按分组一套见 §四「刻意不做」）。
3. **引用下拉的搜索是子串匹配**（`SearchableSelect` 既有语义），不是全站池子用的 `fuzzyMatch`；
   要统一的话应该改那个原语本身，而不是在销售页另写一套。
4. **材料明细导出兜底只在工艺单这一条路上生效**；将来若新增别处的销售单导出，必须复用
   `materialRefText` / `document()`，不要另写一份取值逻辑。
