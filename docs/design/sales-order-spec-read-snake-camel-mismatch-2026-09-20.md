# 销售单「材料明细写了、保存了，再打开就没了」——根因与修复（2026-09-20）

用户报告：**销售订单的材料明细，写了、也保存了，但再打开就又没有了。**

---

## 1. 根因（已复现）

**数据在库里，是读的时候没读出来。** 一个字段在这条链路上有三个名字：

| 名字 | 例子 | 用在哪 |
|---|---|---|
| 请求键 `snake_case` | `rib_spec` | 前端表单、`POST`/`PATCH` 的请求体、版本快照 `snapshot` |
| Prisma 列名 `camelCase` | `ribSpec` | 数据库、**以及 `GET /sales-orders/:id` 返回的 JSON** |
| 界面中文名 | 伞骨（孔对孔） | 表单标签、工艺单印刷 |

后端有一张**单向**表 `SPEC_SCALAR_FIELDS`（`["rib_spec", "ribSpec"]`）驱动**写入**侧的映射，
所以保存是对的、库里也确实有值。但**读取**侧（前端表单回填、工艺单导出）是按**请求键**取值的，
拿到手的却是 Prisma 整行 —— 于是 `order["rib_spec"]` 在一行只有 `ribSpec` 的对象上永远是
`undefined`。

37 格里只有 `factory` 一个**碰巧没坏**：它的请求键与列名恰好同名（都是 `factory`）。

### 复现 1：工艺单导出（探针，直接跑真实 service）

用**真实 Prisma 行形状**喂 `SalesOrderExportService.document()`：

```json
{
  "factory": "JBN",                  ← 唯一活下来的（键名与列名相同）
  "completionText": "2026.7.30",      ← 「进仓」后缀丢了
  "attentionNote": "",                ← 注意事项整段消失
  "materialLines": 0,                 ← 材料明细 18 项，一行都不印
  "processLines": 0,                  ← 工艺要求 9 项，一条都不印
  "fabricUsage": [],                  ← 布量 5 格全空
  "shippingMarkFront": ""             ← 正唛／侧唛全空
}
```

工艺单是**要发给工厂**的：材料与工艺那一整块是空白。

### 复现 2：前端编辑页（用户看到的那个）

把组件测试的夹具改成**真实接口形状**（camelCase）后立刻变红：

```
- Expected  旧伞骨
+ Received
❯ test/sales-order-editor.test.tsx:158
```

## 2. 影响面比「没显示」严重：重开再保存会把数据擦掉

这是本次要单独点出来的一条 —— 它把「显示 bug」变成了**数据丢失**：

1. 打开单据 → 37 格全空（读不出来）；
2. 用户随手点「保存」 → `specPayload()` 照设计**把 37 个键全带上**，没填的给**空串**；
3. 而后端对细化标量的口径是**「空串 = 清除这一格」**（这是有意的，否则永远清不掉一格）；
4. ⇒ 库里真实存在的值被**写成 NULL**。

也就是说：**只打开一次、再点一次保存**，材料明细就真的没了。用户说的「保存了，再打开又没有了」
里，前一次是「保存成功但读不出」，后一次很可能是「重开再保存」把值真正抹掉了。

**库里还有救**：`sales_order_versions` 的 **v1 快照**是建档时按请求键写的，含当时填的全部值
（见下面第 5 节的诊断 SQL）。

## 3. 为什么测试没抓到（这才是它能上线的原因）

**两个读侧的测试夹具都写成了「请求键」形状 —— 也就是那个错代码期望的形状，而不是数据库/接口
真实吐出来的形状。**

- `apps/api/test/sales-order-production-sheet.test.cjs` 的 `sample1()` / `sample2()`：
  `rib_spec: "…"`；
- `apps/web/test/sales-order-editor.test.tsx` 的编辑回填用例：`rib_spec: "旧伞骨", factory: "JBN"`。

夹具**定义了被测代码的预期**，而测试里唯一的真相来源就是夹具本身：`order["rib_spec"]` 在夹具上
读得到值，于是全绿。这跟第 1 节那张表是同一个错误，只是出现在了测试里。

顺带一个放大器：`ExportOrder` 类型上原本挂着 `[specKey: string]: unknown` 索引签名，
等于告诉编译器「随便按什么名字取都行」—— 这条错因此**编译期也过得去**。索引签名已删除。

## 4. 修复

**一处翻译，两个读侧共用同一个口径。**

### 4.1 后端：`specScalarRow(row)`（`sales-orders.service.ts`）

Prisma 行（列名）→ 37 个细化标量的请求键取值，**两种形状都认**（先请求键、再列名）：

- 认请求键是必要的：`sales_order_versions.snapshot` 存的就是请求键，两种形状在这个库里**都真实存在**，
  逼调用方先转换只会把同一个错误挪个地方；
- 空串**不回落**到列名（空串是「用户清了这一格」，不是「没有值」）。

`document()` 里统一过一遍这个函数，37 个字段的读取就只有这一条路了。

### 4.2 前端：`specFromOrder(order)` + `snakeToCamel(key)`（`lib/sales-order-spec.ts`）

`specFromOrder` 把接口行转成表单能直接用的 `{ 请求键: 文本 }`；`snakeToCamel` 做机械转换，
**不再抄第三份映射表**（后端 `SPEC_SCALAR_FIELDS` 已经是权威表，「列名 = 请求键的驼峰」这条假设
由测试逐键钉住，见第 6 节）。

编辑器原来那三行（`for (const key of SPEC_SCALAR_KEYS) loadedSpec[key] = asText(order[key])`）
换成一行 `setSpec(specFromOrder(order))`。

## 5. 已受损数据：先诊断，再决定要不要修

**只读诊断**（不写库）—— 找出「列是空的、但 v1 快照里有值」的单据：

```sql
SELECT o.order_no, o.rib_spec AS now_rib_spec, v.snapshot->>'rib_spec' AS v1_rib_spec,
       o.attention_note AS now_note, v.snapshot->>'attention_note' AS v1_note
FROM sales_orders o
JOIN sales_order_versions v ON v.sales_order_id = o.id AND v.version = 1
WHERE o.deleted_at IS NULL
  AND (o.rib_spec IS NULL OR btrim(o.rib_spec) = '')
  AND NULLIF(btrim(v.snapshot->>'rib_spec'), '') IS NOT NULL
ORDER BY o.updated_at DESC;
```

把 `rib_spec` 换成任意细化键即可看别的格；也可以直接 `jsonb_each_text(v.snapshot)` 遍历 37 个键。

**恢复口径**：每个键取「**最新的一个非空快照值**」写回列（v1 是建档时的值，之后被擦掉的版本记的是
空串，所以不能只认最新版本、也不能只认 v1）。这是一次**改生产数据**的操作，且本机没有可用数据库、
无法先验证，因此本轮**只落诊断 SQL 与口径，没有生成可执行脚本**。
需要的话把诊断结果（条数）发我，我再补一个带守卫的修复脚本 + 用例。

## 6. 回归护栏（都已跑通）

| 层 | 用例 | 钉住什么 |
|---|---|---|
| API | `sales-order-production-sheet.test.cjs` 夹具改为 **Prisma 行形状** | 夹具不许再退回请求键（根因就在这） |
| API | 「回归 2026-09-20：Prisma 行必须读得出」 | 材料 14 行 / 工艺 8 条 / 布量 `["1.2","0.3"]` / 注意事项 / 完工后缀都**不许是空的** |
| API | 「版本快照形状也读得出」 | 两种键名都认，snapshot 渲染路径不断 |
| API | `sales-order-spec.test.cjs`：`specScalarRow` 2 条 | 37 键一个不少；空串不回落；Decimal → 文本 |
| API | `sales-order-dto.test.cjs`：新增 1 条 | **`snakeToCamel(请求键) === 列名`** 逐键成立 —— 前端回填靠这条假设，破了就是同一个静默空白 |
| web | `sales-order-editor.test.tsx` 回填用例夹具改为 camelCase | 用户报的那条路（四个区各抽查一格） |
| web | `sales-order-spec.test.mjs`：`specFromOrder` 3 条 + `snakeToCamel` 1 条 | camelCase 读得出、Decimal/null/缺键 → 文本、snapshot 形状、机械驼峰 |

`snakeToCamel` 那条契约测试是**这次真正的防线**：它把「两个 workspace 各有一份清单」的耦合
从「靠夹具自证」变成「靠后端权威表逐键校验」。

## 7. 教训

1. **夹具必须是真实形状，不是方便的形状。** 两个读侧的测试都在用请求键夹具自证，于是同一个错
   在前后端各绿了一次。夹具抄错的代价比代码写错更大 —— 代码错了测试会红，夹具错了测试会说谎。
2. **同一实体三个名字（请求键 / 列名 / 中文名）时，转换必须有唯一的落点。** 写侧有 `SPEC_SCALAR_FIELDS`
   这张表，读侧当时什么都没有，于是各读各的。现在读侧也收敛到一个函数。
3. **`[key: string]: unknown` 这类索引签名会关掉类型检查**，正是它能编译通过的原因。
4. 「读不出来」在**有编辑保存**的页面上会自动升级成「数据被清空」：读侧的空值会被当作「用户清空了
   这一格」再写回去。任何「空串 = 清除」的语义都必须配一个**能正确回填**的读路径。
