# 币种可配置字典 + 采购草稿行勾选删除 + 一单多采购单（按供应商拆分）

- 状态：已实现（待真实 PostgreSQL 验收迁移）
- 日期：2026-09-14
- 来源需求：业务方 2026-09-14 提出的三项整改
  1. 全站所有需要币种/支付的入口都改成可选下拉，不再只支持人民币/美元；
  2. 采购单带入 BOM 后，每条物料前要有复选框，可勾选后批量从**采购单草稿**中去除（BOM 表不变），然后下单；
  3. 支持一张销售订单创建多张采购单，同供应商的物料合并在同一张上。

## 1. 决策

| # | 决策 | 依据 | 影响 |
| --- | --- | --- | --- |
| D1 | 币种用**可配置字典**（`dictionary_types.key = 'currency'`）实现，不写死枚举 | `docs/product/PRD.md`「支持多币种，币种为可配置字典」、`docs/product/SRS.md`「币种……应支持授权用户通过管理接口维护」、宪法 Configurable Business Categories | 前端从 `GET /dictionaries/currency/items` 取启用项；后端在写入入口做一致性校验；管理员可增/改/停用币种 |
| D2 | 币种校验放在**服务层**（`CurrencyService.assertSupported`），不放 DTO | 币种是数据库里的字典数据，class-validator 的同步校验拿不到它 | 越权/手工请求绕过前端下拉时同样被 422 `CURRENCY_NOT_SUPPORTED` 挡住 |
| D3 | 字典缺失或为空时**放行**任意非空编码，只记录不阻断 | 「字典为空」是部署/迁移状态问题，不该把全站金额录入锁死 | 一旦字典有启用项就以字典为唯一口径；单测钉住这条兜底是刻意行为 |
| D4 | 历史库中已出现、但不在内置清单里的币种，由迁移补成「`XXX（历史值）`」字典项 | 宪法「已被业务数据引用的类目必须保留历史快照」 | 老单据编辑时不会被币种校验卡住；管理员能在字典里看到并清理 |
| D5 | 采购单币种是**整单一个**（沿用 `purchase_orders.currency`），不做行级币种 | 与应付来源、供应商付款、对账的现有口径一致 | 拆分出的每张采购单各自带币种（默认继承草稿币种，可按组覆盖） |
| D6 | 「一张订单多张采购单」= **按供应商自动拆分**，由后端一个事务批量生成 | 采购单头部的供应商、后续到货/应付/对账都需要单一供应商口径 | 新增 `POST /purchase-orders/split`；组内明细的供应商强制取组供应商 |
| D7 | 草稿行勾选删除**只改前端草稿状态**，不调用任何 BOM 写接口 | BOM 是工程主数据，采购只是按需取其中一部分行 | 删除后把「带入 BOM表明细」置为否，避免用户误以为草稿仍是 BOM 的镜像 |

## 2. 数据模型与迁移

无表结构变更，只有字典数据：

- `apps/api/prisma/migrations/20260913100000_currency_dictionary/migration.sql`
  - 建 `dictionary_types(key='currency', name='币种')`；
  - 写入 15 个内置币种（CNY/USD/EUR/HKD/JPY/GBP/TWD/SGD/AUD/CAD/KRW/THB/MYR/VND/INR）；
  - 扫描 `information_schema` 中所有带 `currency` 列的基表，把已有编码补成「（历史值）」项；
  - 三条 INSERT 全部 `ON CONFLICT DO NOTHING`（幂等）；无用户（空库）时 `RETURN`，交给 `prisma/seed.ts`。
- `apps/api/prisma/seed.ts` 复用 `src/platform/currency/currency-catalog.ts` 的同一份清单，避免两处漂移。

## 3. 后端

### 3.1 币种字典服务

- `apps/api/src/platform/currency/currency-catalog.ts`：纯数据（`DEFAULT_CURRENCIES`、`CURRENCY_DICTIONARY_KEY`）。
- `apps/api/src/platform/currency/currency.service.ts`：`listActive()` / `assertSupported()` / `isSupported()`。
- `apps/api/src/platform/currency/currency.module.ts`：`@Global()`，业务模块无需逐个 imports。
- 注入点（全部用 `@Optional()` 末位构造参数，保证既有单测 `new Service(prisma, audit)` 继续可用）：

| 模块 | 位置 | 字段 |
| --- | --- | --- |
| 销售 | `sales-orders.service.ts` create/update | 销售单币种 |
| 销售 | `customers.service.ts` create/update | 客户币种 |
| 采购 | `purchase-orders.service.ts` create/update/split | 采购单币种 |
| 财务 | `customer-payment.service.ts` create | 收款币种 |
| 财务 | `supplier-payment.service.ts` create | 付款币种 |
| 财务 | `receivable-adjustment.service.ts` create | 调整币种 |
| 财务 | `reconciliation.service.ts` create | 对账币种 |
| 财务 | `supplier-payable-reconciliation.service.ts` create | 应付对账币种 |
| 人事 | `payroll-ledger.service.ts` generate/update | 工资台账币种 |
| 人事 | `salary-payment.service.ts` create | 工资付款币种 |

### 3.2 按供应商拆分下单

`POST /api/v1/purchase-orders/split`

```jsonc
{
  "order_no": "SO-2026-001",
  "bom_id": "…",
  "currency": "CNY",          // 组未指定时继承
  "place_order": true,        // false 只生成草稿
  "groups": [
    { "supplier_id": "…", "currency": "CNY", "expected_date": "…", "items": [ /* ItemDto */ ] }
  ]
}
```

- 一组 = 一张采购单；组内明细的 `supplier_id` 一律被覆盖为组供应商。
- 所有分组在**同一个 `$transaction`** 内写入：任一组的引用校验（`refs()`）或下单前校验（`assertOrderableItems`）失败，则一张都不生成。
- `place_order=true` 时复用与单张下单相同的必填校验（BOM、至少一行、物料/单位/供应商/数量/单价）。
- 每张采购单的 `extension_data.purchase_split` 记录 `{ by: "supplier", supplier_id, group_index, group_count }`，便于追溯来源。
- 结构调整：`create()` 拆出 `prepare()` / `orderData()` / `itemData()`，与原实现行为等价（`assertOrderable` 现在把采购单归一化后调用 `assertOrderableItems`，两处共用一套规则）。

## 4. 前端

### 4.1 币种下拉基础设施

- `apps/web/lib/currency-options.ts`：零依赖纯逻辑（字典项 → 选项、历史值兜底、默认值），可被 `lib/**/*.test.mjs` 直接 import。
- `apps/web/lib/currency-catalogue.ts`：唯一发请求的模块（`GET /dictionaries/currency/items`，失败回落内置清单），并 re-export 纯函数。
- 各页面在**独立 effect** 里拉一次字典（不是业务数据，刷新业务数据时不重复拉取），把 options 塞进 `ActionDialog` 的 `select` 字段或草稿编辑器的 `Select`。

改造的入口：销售单币种、客户币种、采购单币种、财务收款/付款/对账/应付对账、人事工资台账（新建+编辑）、工资付款。原先这些位置分别写死 `"USD"`（销售、收款、对账、采购）与 `"CNY"`（付款、应付对账、工资），其中**采购单写死 USD 而后端默认 CNY** 属于既有的口径矛盾，本轮一并消除。

### 4.2 采购草稿行勾选删除

- 草稿表格新增行首复选框列 + 表头全选框，工具栏新增「移除选中 N 行」。
- `removeSelectedDraftRows()` 只过滤本地 `purchaseDraft.items`，并把「带入 BOM表明细」置为否；**不调用任何 BOM 接口**（组件测试断言整条链路没有任何 `POST/PUT/PATCH/DELETE /boms…`）。
- 结构性变化（重新带入 BOM、打开已保存采购单）会清空选择，避免索引漂移。

### 4.3 拆分下单 UI

- 按 `supplier_id` 分组；≥2 组时显示分组预览（供应商、行数、金额合计）。
- 两个入口：「按供应商拆分保存 N 张草稿」与「按供应商拆分下单（N 张）」，都调用同一接口的 `place_order` 开关。
- 任一行未选供应商、或已保存的采购单（有 id）不允许拆分，直接给出明确错误。

## 5. 验证

| 层次 | 命令 | 结果 |
| --- | --- | --- |
| API 类型检查 | `npm run typecheck --workspace=@dilee/api` | 通过 |
| API 单元测试 | `npm run test:unit:api` | **870 / 870 通过**（含新增 16 + 4 条） |
| Web 类型检查 | `npm run typecheck --workspace=@dilee/web` | 通过 |
| Web 单元测试 | `cd apps/web && npm run test:unit` | **501 组件用例 + 124 lib 用例全部通过**（含新增 4 + 9 条） |
| 迁移实际执行 | `npm run db:migrate:deploy` | **未执行**：本机没有可用 PostgreSQL（Docker 守护进程未运行），迁移只做了静态守卫 |

新增测试：

- `apps/api/test/unit/currency-service.test.cjs`（7）：字典过滤/排序、422 码与 supported 列表、空字典兜底、空编码不查库、内置清单完整性。
- `apps/api/test/unit/purchase-order-split.test.cjs`（9）：一组一张、供应商覆盖、`purchase_split` 元数据、草稿/下单、校验失败零写入、结构性校验先于引用查询、逐组币种校验。
- `apps/api/test/unit/currency-dictionary-migration.test.cjs`（4）：迁移排序、内置币种齐全、三条 INSERT 幂等、历史值兜底扫描。
- `apps/web/lib/currency-options.test.mjs`（9）：排序/去重/停用过滤/历史值兜底/默认值回落。
- `apps/web/test/procurement-draft.test.tsx`（4）：勾选批量移除且 BOM 零写请求、全选/取消全选、拆分提交体（分组、组内供应商、数量）、单供应商不出拆分入口。

## 6. 顺带修掉的问题（同轮次发现）

1. **采购单币种前后端矛盾**：页面写死 `"USD"`，后端 `?? "CNY"`。统一为字典可选 + 草稿自带币种。
2. **`notifyFinance` 的无效 try/catch**：`try { void action(...) } catch {}` 永远捕不到异步异常；已简化为直接 `void action(...)`（`action` 自身已有错误提示）。
3. **`DataTable` 单元格不翻译状态**：`flexRender` 对函数型 cell 返回 React 元素，`text()` 的「字符串才翻译」分支对默认单元格永不成立，于是表头中文、单元格英文（`draft`/`confirmed`）。本轮**没有**改成全局翻译（workbench / QC / 外协面板的测试明确钉住「后端原值」契约），而是提供 `statusCell<T>()` 工厂，并给生产单状态列与工资付款状态列补上——这两处测试本来就要求中文。
4. **`<label>` 包裹按钮导致无障碍名称为空**：按 accname 规范，label 内嵌控件的文本会被跳过，采购草稿的「带入 BOM表明细」开关读屏时无名；已补 `aria-label`。
5. **工资总览页把加载失败渲染成正常空表**：接口 403 时仍渲染「暂无车间工资台账」；已改为失败时只留错误态与重试入口。
6. **测试与实现漂移**：`salary-page.test.tsx`、`hr-page.test.tsx`、`production-page.test.tsx` 里若干断言与页面实际行为不一致（同一员工的重复行、同一金额出现两次、Radix 模态下 `getByRole` 不可见、下拉未展开就找 option、同一用例内二次渲染未 cleanup），已逐条改成可验证的写法。

## 7. 未验证 / 待确认

- 迁移未在真实 PostgreSQL 上执行过；`DO $$ … EXECUTE format(…)` 的动态 SQL 只做了静态守卫。
- `apps/api/test/http`（HTTP 合约）与 `test/integration`（真实库）未运行，因此 `POST /purchase-orders/split` 的 DTO 白名单、鉴权与错误信封未做端到端验证。
- 历史值兜底会把老库里任何拼写错误的币种也补成字典项（标注为「历史值」）。是否要在上线后统一清洗，需要业务确认。
- 拆分后各张采购单的到货/应付/对账仍是独立链路；跨采购单的「同一订单到货进度」聚合视图尚未提供。
