# 库存汇总整表空白：请求行超过 nginx 上限（2026-10-16）

## 来源需求（用户原话）

> 现在排查一下，原料入库单批准之后，入库状态也显示入库成功了，备注显示质检通过自动生成入库草稿。但是库存里没有看到相应的物料

追问一轮确认现象（用户选「**整张表都是空的（其他物料也看不到库存）**」）——
这一条把原因钉死在「取数失败」，而不是「这个物料的库存行不见了」。

复现位置：`仓库 → 原料仓储情况 → 库存汇总`。

---

## 一、根因：库存汇总的取数请求被 nginx 以「URL 过长」打回（414）

| 环节 | 事实 |
| --- | --- |
| 页面取数 | `app/warehouse/raw-material-storage/page.tsx` 把**全部物料 id** 拼进查询串：`/inventory/raw-material-balances?material_ids=<每个 UUID 37 字节>` |
| 线上物料 id | UUID（36 字符 + 分隔符 = **37 字节/个**） |
| 生产机链路 | 浏览器 → nginx（`.deploy-run-118/nginx-dilee.conf` 的 `location /api/`）→ PM2 `dilee-api` |
| nginx 限制 | 那份配置**没有**放宽请求头，走默认 `large_client_header_buffers 4 8k`，而「一条请求行（方法 + URL + HTTP 版本）不能超过一个 buffer」= **8192 字节** |
| 越线点 | 物料 **≈219 个**（53 字节固定前缀 + 37×N）。300 个物料时实测请求行 **11165 字节**（本机测试复现，见 §四） |
| 结果 | nginx 直接回 **414 Request-URI Too Large**，请求**根本到不了 API**；`apiGet` 拿到 HTML → `response.json()` 失败 → 抛 `请求失败（HTTP 414）` |

**为什么症状长这样**（用户描述的三件事逐条对上）：

1. 「入库状态=入库成功」：入库单来自 `GET /raw-material-inbounds`（**短 URL**，早一步就成功了），
   过账写的库存事实也确实进了库 —— 数据一直在，是**读**不到。
2. 「库存里没有看到相应的物料」：这一页 `Promise.all` 前四个请求成功后才取余额，余额失败时
   `balances` 留在空数组 → 库存汇总**整表空**（而且空态写的是「暂无原料库存」，等于把故障说成没库存）。
3. 只影响这一页：`app/warehouse/page.tsx`、`material-slip-editor.tsx` 调同一个接口时**不带** `material_ids`，
   `plan-detail-sheet.tsx` 只带一张计划的物料（几十条，远不到 8k）。

## 二、修法

### 1. 余额取数不再拼物料 id（`page.tsx`）

`GET /inventory/raw-material-balances` 不给 `material_ids` 时返回**全部原料余额**
（`inventory.service.ts`：空数组 = 不过滤），而这一页本来就要**全部物料**——
它给每个物料都补一行 0（`mergeMaterialBalances`），少谁都是错的。
所以去掉筛选是**同一个结果集、没有 URL 长度上限**：`app/warehouse/page.tsx` 与
`material-slip-editor.tsx` 一直是这么调的，这次只是让这一页与它们一致。

常量与理由写在 `RAW_MATERIAL_BALANCES_PATH` 上（含 8k 的算式），免得下一个人"顺手优化回去"。

### 2. 取数失败不再冒充「没有库存」（同一文件）

新增 `balanceError` 状态，余额那一次请求**单独 try/catch**（不再和另外四个请求共用页面级 `error`）：

- 库存汇总那张卡：失败时**不渲染表**（表在、0 行，读起来就是"库存是空的"），改成
  `库存汇总没取到：<原因>` + 重试按钮；
- 「入库单与库存关系」面板里的「当前原料汇总条目：0」同样改口径（不再报 0）。

为什么值得单独做：这次排查花时间的地方正是**这句话在说谎**——用户看到"没有物料"，看到的是"没取到"。
入库单那张表**保持可用**（入库是否生效的唯一凭证，恰恰是那时候最需要能看的）。

## 三、排查时顺带发现的第二个成因（已修，不是本次症状）

`ensureUnusedAndDelete`（采购主数据删除）的引用检查**漏了「数量所在的那几处」**：

| 目标 | 改前只数 | 改后补上 |
| --- | --- | --- |
| 物料 | `bomItem` | `purchaseOrderItem` / `rawMaterialInbound` / `rawMaterialMovementLine` / `inventoryFact` / `stocktakeLine` |
| 单位 | `material.defaultUnitId` / `bomItem` / `operationCatalog` / `productionOrderOperation` | `purchaseOrderItem` / `rawMaterialInbound` / `rawMaterialMovementLine` / `inventoryFact` |

后果链条：一个**已经收过货、账上有库存**的物料（只要没有 BOM 行引用）能被"删除"（软删）→
`GET /materials`（过滤 `deletedAt` + `materialType`）与
`/inventory/raw-material-balances`（要求 `material.deletedAt = null` **且** `unit.deletedAt = null`）
同时把它挡掉 → **库存事实还在库里，但库存汇总里那一行静默消失**，而入库单列表照旧显示它 ——
症状与本次一模一样，只是成因不同。两个模型里能"造出这种隐形"的字段正好都指向这两张主数据表。

修法：把这几处引用一起数（`inventory_facts` 没有 `deletedAt`，事实不可删改；
`stocktake_lines` 也没有）。已写进既有契约"基础资料已被业务引用，只能停用"，
没有新增错误码、没有迁移。

## 四、测试（先红后绿，数字是实际跑出来的）

| 用例 | 红 | 绿 |
| --- | --- | --- |
| `apps/web/test/raw-material-storage.test.tsx` ·「300 个物料时请求行 ≤ nginx 8k」 | **11165 > 8192** | 通过（URL 变成固定长度） |
| 同上 ·「300 个物料时库存汇总仍收下全部物料」（断言「当前原料汇总条目：300」） | 通过（本来就对，钉住"去掉筛选不改结果集"） | 通过 |
| 同上 ·「余额取数失败时不许显示『暂无原料库存』」 | 找不到原因文案 | 通过 |
| `apps/api/test/unit/procurement-master-data-service.test.cjs` · 物料/单位各 +1 条「被采购或库存引用时 409」 | 软删成功（漏引用） | 通过 |
| `apps/api/test/procurement-master-data.test.cjs`（既有）| 新增引用检查后桩缺模型 → TypeError | 桩补上四个模型后通过 |

三个新用例的 id 桩**必须写成 UUID 形状**：用 `m-1` 这样的短桩算出来的 URL 只有实际的三分之一，
第一条会假绿（第一次就踩了这个坑，已写进注释）。

## 五、上线与风险

- **纯前端 + 一段服务端校验逻辑，无迁移、无接口契约变化**；前后端可独立部署。
  前端先上线，用户刷新这一页库存就回来了（**不需要修数据**：库存事实一直在）。
- **同类隐患（未改，留待决定）**：`plan-detail-sheet.tsx:276` 也把物料 id 拼进查询串 ——
  一张采购计划几十条、离 8k 还远，但同样是"URL 随数据量增长"的形状；那一处**取数失败是刻意不阻断**的
  （库存只是决策支持），要不要顺带改成"失败时说一句"由用户定。
- **一句话规则**（这次写进注释）：**筛选条件不要放进会随数据量增长的 URL** ——
  要么不筛（像本页），要么走 POST body，要么分页。客户端与 API 之间还隔着一层 nginx，它的请求行上限是 8k。
