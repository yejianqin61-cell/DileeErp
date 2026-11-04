# 销售单「每种一张图」：材料行与明细行都能插图（2026-11-04）

## 0. 需求原话与排查结论

用户这一轮的原话：

> 针对当前项目，销售模块，销售订单要支持每个物料插入图片。我记得以前是有过这个设计的，
> 在物料清单里支持上传图片。然后导出的销售单，物料图片统一归在表单底部。你排查一下。
> 用户还需要比如说一个生产单里有 5 种伞布，11 种伞头，能在每种里插入图片。

**排查结论（先说哪一半已经有了）**：

| 能力 | 2026-11-04 之前的状态 |
|---|---|
| 物料清单上传图片 | **有**（2026-09-24）：`material_images` + `POST/DELETE /materials/:id/image`，浏览器压 WebP、服务端只校验容器；物料清单页有缩略图/换图/删图 |
| 销售单材料明细引用物料并显示缩略图 | **有**（2026-09-24）：18 格 + 「其它」行 + 「再加一款」行都存 `material_id`，编辑器显示缩略图 |
| 导出销售单的图片排到底部图片区 | **有**（2026-09-24）：`GET /sales-orders/:id/export-images` 给候选、`POST /:id/production-sheet.xlsx` 走 multipart，图片排表尾一排 5 张、可自行拖拽 |
| 一个类目填多款 | **有**（2026-10-29）：同类目下「再加一款」行 |
| **行上的图不依赖物料清单**（没建物料 / 物料没图 / 客户临时给样照） | **没有**：图片只能来自物料清单里那一张；行上没引用物料就没图 |
| **细分明细每行插图**（伞布明细 / 伞头配色） | **没有**：导出件一直写着「图片不录入、导出留空」，而真实生产单样例（`example/销售单/`）里花色一行 6 张、伞头 15 行各 1 张 |
| 生产订单（`/production/orders`）的 BOM 行 | 未做（本轮**不在范围**，用户拍板只做销售单） |

所以本轮要补的是**两处行级图片**，不是重做 2026-09-24 那一套。

用户当日拍板的三件事：

| 问题 | 用户的选择 |
|---|---|
| 「每种」指哪一块 | **两处都要**：材料明细的类目行（含「再加一款」）+ 细分明细行 |
| 图片来源 | **两种都支持**：能引用物料就用物料图，行上也能直接传；**该物料在物料清单里没有图时，问一句是否同时写入物料清单**（方便下次取用） |
| 导出位置 | **两个都印**：明细行印在该行「图片」列，材料行排表单底部图片区 |

## 1. 数据模型

### 1.1 图片库：`sales_order_images`

图片是**独立的库行**，按销售单隔离（`sales_order_id` 不可空）。材料行/明细行只存 `image_id` 指针。

为什么必须独立：`sales_order_material_extras` 与 `sales_order_spec_details` 的替换语义是
**「软删旧的 + 建新的」**（整块替换），每次保存行 id 都会变。字节挂在行上，保存一次要么丢图
（新行没有字节），要么把整块图重拷一遍。独立库里上传一次、保存只搬指针；保存末尾再把
「这一单没有任何行引用的图片」软删（用户传了又取消的那种）。

字节口径与 `material_images` **完全一致**：浏览器压成 WebP 再传，服务端用同一个
`validateMaterialImage` 解开 RIFF 容器核对真实尺寸（≤2MB、边长 ≤2000），读接口 `ETag = sha256`
+ `must-revalidate`。审计只记元数据（宽高/字节数），不记字节。

### 1.2 18 格各自的图：`sales_order_slot_images`

18 个材料格是 `sales_orders` 上的 18 个标量列，**没有行**可以挂 `image_id`；
而「每格一张图」必须能表达（哪怕这一格没引用任何物料）。所以一行 = 一格的一张图，
唯一键 `(sales_order_id, spec_key)`。

**替换是逐格对齐**（与 `sales_order_material_refs` 同一条理由：唯一索引不看 `deleted_at`，
软删了再建必撞唯一约束）：值变了改这一行（顺手清 `deletedAt` 复活）、请求没提到的软删、
新出现的才插入。

### 1.3 两处行级图：`image_id` 列

| 表 | 新增列 | 语义 |
|---|---|---|
| `sales_order_material_extras` | `image_id UUID NULL` | 「再加一款」/「其它」行自己的图；有引用物料时**优先用这张**，没有才回退物料图 |
| `sales_order_spec_details` | `image_id UUID NULL` | 细分明细行自己的图（伞布明细 / 伞头配色 每行一张） |

两个外键都是 `ON DELETE SET NULL`（图片被硬删时那几行只是「没有图」，不是数据异常）。

迁移：`20261104180000_sales_order_row_images`。

## 2. 接口契约（前端与后端按这份实现）

### 2.1 上传图片

`POST /api/v1/sales-orders/:id/images`，`multipart/form-data`，字段名 `file`。

- 文件：WebP（浏览器已压好），≤2MB；服务端用 `validateMaterialImage` 校验，**不信 Content-Type**。
- 前置：销售单存在且未删除（`SALES_ORDER_NOT_FOUND`）。
- 回执：`{ data: { id, width, height, byte_size, sha256, updated_at }, meta: {} }`。
- 错误码：沿用 `validateMaterialImage` 的 `MATERIAL_IMAGE_*`（`MATERIAL_IMAGE_FILE_REQUIRED` /
  `MATERIAL_IMAGE_TOO_LARGE` / `MATERIAL_IMAGE_NOT_WEBP` …）。

**没有 DELETE 端点**：行上「删除图片」只清客户端状态，保存时由服务端把无引用的图软删。
未保存就放弃的图会留在库里直到下一次保存 —— 与「上传后取消」同一条代价，写在 §7。

### 2.2 读图片

`GET /api/v1/sales-orders/:id/images/:imageId`

- 返回 WebP 字节；`Content-Type: image/webp`、`ETag: "<sha256>"`、
  `Cache-Control: private, max-age=0, must-revalidate`；`If-None-Match` 命中回 **304 且无 body**。
- 图片必须属于该单且未删除，否则 404 `SALES_ORDER_IMAGE_NOT_FOUND`。

### 2.3 保存/读取时行的形状

**请求（`POST /sales-orders`、`PATCH /sales-orders/:id`）** —— 三个键都是「整块替换」语义
（`undefined` = 不动、`[]` = 清空）：

```jsonc
{
  "slot_images": [ { "spec_key": "canopy_spec", "image_id": "<uuid>" } ],
  "spec_details": [ { "group_name": "伞头配色", "name": "Hawái", "color": "…", "barcode": "…",
                      "quantity": "167", "unit": "打", "sort_order": 0, "image_id": "<uuid>" } ],
  "material_extras": [ { "spec_key": "canopy_spec", "content": "190T 素色黑",
                         "material_id": "<uuid>", "image_id": "<uuid>", "sort_order": 0 } ]
}
```

`image_id` 都可省略（= 这一行没有自己的图）。`slot_images[].spec_key` 必须是 18 个材料栏位之一，
否则 422 `SLOT_IMAGE_KEY_UNSUPPORTED`；`image_id` 必须存在、未删除，且属于本单
（返单/复制时允许指向来源单，服务端会把字节**复制**成新单自己的行，见 §2.5）。

**读取（`GET /sales-orders/:id`、返单预览 `copy`、复制快照 `copy`）**：

```jsonc
{
  "slotImages": [ { "id": "…", "specKey": "canopy_spec", "imageId": "…",
                    "image": { "id": "…", "width": 800, "height": 600, "byteSize": 51234, "sha256": "…" } } ],
  "specDetails": [ { "id": "…", "groupName": "…", "name": "…", "imageId": "…", "image": { /* 同上摘要 */ } } ],
  "materialExtras": [ { "id": "…", "label": "…", "materialId": "…", "imageId": "…", "image": { /* 同上 */ } } ]
}
```

- 详情接口给的是 **Prisma 列名**（camelCase）；返单/复制的 `copy` 给的是**请求键**（snake_case），
  与 37 个细化标量、明细列名同一条「读侧认两种形状」纪律。
- 图片摘要**绝不含字节**（详情是编辑页每次打开都拉的接口）。
- 版本快照跟着请求载荷走（`spec_details` / `material_extras` / `slot_images` 里自然带上 `image_id`），
  不存字节。

### 2.4 导出候选与导出请求

`GET /sales-orders/:id/export-images` → `{ data: { images: ExportImageCandidate[] } }`：

```ts
type ExportImageCandidate = {
  spec_key: string;              // 18 键 / `extra:<行id>` / `detail:<行id>`
  label: string;                 // 栏位名 / 类目名 / 明细行名（含分组）
  kind: "material" | "extra" | "detail";
  material_id: string | null;    // 有物料引用才有
  material_code: string | null;
  material_name: string | null;  // 名称 规格 颜色
  has_image: boolean;
  image_version: string | null;  // sha256（破缓存用）
  image_source: "row" | "material";   // 行自己的图 / 物料清单那张
  image_id: string | null;       // 行自己的图 = sales_order_images.id
  image_url: string;             // 可直接 <img src>；含 /api/v1 前缀与 ?v=sha
};
```

- 顺序 = 印刷顺序：18 键按类目序，每个类目后面紧跟它的「再加一款」行，然后自由「其它」行，
  最后是细分明细行（按分组与行序）。
- **有图才列**（`has_image=true` 的才进弹窗）。这是对 2026-09-24 行为的一次**有意收紧**：
  那时后端把「引用了但物料没图」的栏位也列出来、由前端过滤；现在候选同时含行图与明细行图，
  继续把没图的列出来只会让人以为勾了就有图（勾了之后导出必然 422）。
- 行图优先：`image_source` 由服务端定（行自己的图 > 物料清单图）。
- `image_url`：行图 `/api/v1/sales-orders/{id}/images/{imageId}?v={sha}`；
  物料图 `/api/v1/materials/{materialId}/image?v={sha}`。

`POST /sales-orders/:id/production-sheet.xlsx`（multipart）**字段名不变** = `spec_key`，
文件 = 浏览器把那张图转好的 JPEG。`files` 上限从「18 + 20」扩到 **18 + 20 + 200**（明细行数不设硬上限，
真正的闸门仍是单张 2MB + 合计 12MB；上限只是别让 multer 用 `LIMIT_FILE_COUNT` 报一个用户看不懂的错）。

### 2.5 返单 / 复制 / 图片归属

- 返单预览与复制快照的 `copy` 带上 `slot_images` / 行上的 `image_id` 与图片摘要（供界面显示）。
- **建单时服务端把图片字节复制成新单自己的行**（`bindOrderImages`）：图片 id 属于本单就复用；
  属于另一张单（返单/复制来源）就插入一条新的 `sales_order_images`（同字节/宽高/sha）再指向它。
  这样删一张单不会让另一张单变破图，也没有跨单引用。
- 更新时只接受本单的图片 id（不存在/不属于本单 → 422 `SALES_ORDER_IMAGE_NOT_FOUND`）。
- 保存末尾 `cleanupOrphanImages`：本单里没有任何活行引用的图片软删。

## 3. 导出件（工艺单）

沿用 2026-09-16 的两样本合一版式，只动两处：

1. **细分明细行**：每行图片印在该行的 **C 列（「图片」列）**。
   - 图片锚在该格上（`oneCellAnchor`，与底部图片区同一手法），按比例缩进 `DETAIL_IMAGE_BOX`
     （最大 56×56px，不放大）；该行行高至少 `DETAIL_IMAGE_ROW_HEIGHT`（44 磅），保证图不压下一行。
   - 分组横幅原来写「（图片见客户原稿，本表不导出图片）」，改成：这一组有图时写
     「（共 N 张图，印在下方「图片」列）」，没图时不写这一段。
2. **表尾图片区**：材料行（18 格自己的图 / 引用物料图 / 「再加一款」与「其它」行的图）仍排在这里，
   每次保存的图片顺序与候选弹窗一致；标签沿用「序号 + 栏位名 + 物料编码/名称」，行图没有物料时
   用该行的内容摘要或「第 N 款」。

明细行的图**不进**底部图片区，材料行的图**不印**在材料行里（模板上没有那一列）——
这正是用户选的「两个都印」：各自印在该去的地方。

## 4. 前端

### 4.1 材料明细（18 格 + 再加一款 + 其它）

- 每格在「从物料清单引用…」旁新增图片控件：无图 = 「上传图片」；有图 = 缩略图 + 「换图」+「删除图片」。
  有物料引用时，物料清单那张图作为**兜底缩略图**显示，行上自己的图优先。
- 行上直接上传且该行**引用了物料、而那个物料在物料清单里没有图**时，弹一次确认：
  「是否同时写入物料清单，作为该物料的图片（下次引用直接带图）？」
  - 选「同时写入」→ 再调一次 `POST /materials/:id/image`（同一个 WebP 字节）；成功后刷新物料池，
    失败（例如没有 procurement 权限）**不回滚行上的图**，只提示原因。
  - 选「只用于本单」→ 只挂在本单这一行。
- 新建单（还没有 id）时控件禁用，提示「先保存销售单，再上传图片」：图片接口按单隔离，
  没有单就没有归属。这是有意的最小实现（见 §7）。

### 4.2 细分明细

- 表格新增一列「图片」（在「品番/品名」之后）：上传/换图/删除，规则同上；
  行上不再显示「图片不录入、导出留空」的说明。

### 4.3 导出弹窗

- 候选项带缩略图（行图走 `image_url`，物料图仍走物料图片接口），默认全勾。
- 勾选后浏览器逐张取图 → 转 JPEG → 以 `spec_key` 为字段名 multipart 上传（逻辑不变，
  只是取图地址从「物料 id」换成候选给的 `image_url`）。

## 5. 测试

| 层 | 文件 | 断言重点 |
|---|---|---|
| API 图片服务 | `apps/api/test/unit/sales-order-row-images.test.cjs`（新） | WebP 校验沿用、按单归属、`slot_images` 逐格对齐（复活）、行 `image_id` 落库、无引用清图、返单/复制时字节复制成新行、图片不属于本单 → 422 |
| API DTO | `apps/api/test/unit/sales-order-dto.test.cjs`（+） | `slot_images` 形状、`image_id` 可选 UUID、多余键被拒 |
| API 导出 | `apps/api/test/unit/sales-order-row-image-export.test.cjs`（新）、`sales-order-material-refs.test.cjs` / `sales-order-material-extras.test.cjs`（契约跟随） | 候选含明细行与行图、行图优先、`detail:<id>` 嵌到 C 列且行高够、底部图片区只含材料行、分组横幅文案 |
| web lib | `apps/web/lib/sales-order-spec.test.mjs`（+） | `slot_images` 载荷、行 `image_id` 载荷、读回两种形状、空行判空不受图片影响 |
| web lib | `apps/web/lib/material-image.test.mjs`（+） | 销售单图片上传：路径、FormData 字段、失败分流 |
| web 组件 | `apps/web/test/sales-order-editor.test.tsx`（+） | 材料格上传/换图/删除、无 id 时禁用、物料无图时的回填确认、细分明细列的图片控件 |
| web 组件 | `apps/web/test/sales-production-sheet.test.tsx`（+） | 行图候选（`image_url`）取图、明细候选一起勾选导出 |

## 6. 验证门禁

- `npm run typecheck`（api + web）
- `npm run test:unit:api`
- `npm run test:unit --workspace=@dilee/web`
- `npx prisma validate` / `prisma generate`
- 迁移**本环境没有 Postgres**（Docker 未启动）：迁移只在文本/SQL 形状、`prisma validate` 层验证；
  上线前必须先 `npm run db:migrate:deploy`，并人工核对「上传 → 保存 → 重开 → 导出」四处。

## 7. 已知边界（有意不做 / 做不到）

1. **新建单在保存前不能传图**：图片接口按销售单 ids 归属；没有 id 就没有归属。保存草稿后再补图。
   （备选是「无主图片」再绑定，多一套清理规则，这轮不做。）
2. **没有独立 DELETE 图片端点**：删图 = 把行/格从载荷里去掉；字节由保存末尾的清理软删。
   上传后不保存就离开，会留下一条无引用的图片行直到下一次保存。
3. **生产订单（`/production/orders`）不感知行图**：用户本轮只要求销售单；生产单的 BOM 行没有图片。
4. **行图不入版本快照的字节**：快照只记 `image_id`（回看能知道「当时挂的是哪一条图」，
   但图片行被清理后只看得到 id）。
5. **图片内容只校验到容器头**（与 2026-09-24 同一条取舍：不引 sharp 解码）。

## 8. 实施结果（2026-11-04 收口）

| 门禁 | 实际结果 |
|---|---|
| `npm run typecheck` | api / coding-worker / web 三个工作区干净 |
| `npm run test:unit:api` | **2775 / 2775 通过**（含新增 `sales-order-row-images.test.cjs` 17 条、`sales-order-row-image-export.test.cjs` 9 条、DTO +3、迁移结构断言重写） |
| web `test:lib` | **424 / 424 通过** |
| web `test:components` | **75 文件 / 1234 测试通过** |
| web `next build` | 通过（在干净副本里跑；本工作区有并行会话的 `next dev` 占用同一 `.next`，同目录构建会互相干扰，不是代码问题） |
| `prisma validate` / `prisma generate` | 通过（迁移 `20261104180000_sales_order_row_images`，全库第 111 条） |
| 真实 Postgres 迁移 | **未跑**（本环境 Docker 未启动）；上线前 `npm run db:migrate:deploy` 并人工核对 |

实施中确认的两处细节（写在这里，免得以后当缺陷重报）：

1. **空行判空口径**：`isBlankMaterialExtra` / `isBlankSpecDetail` 把「有图」也算作非空
   （用户常先传图再填字，判空丢行会让那张图静默消失）；但「只有图、没有类目/内容/品名」的行
   仍被逐行校验拦住 —— 图不能单独印在工艺单上（后端 `normalizeMaterialExtras` 同一条口径）。
2. **`slot_images` 只要出现就算「碰了图片」**（`[]` = 清空 18 格的图），所以编辑页每次保存都会附带
   `slot_images` 并触发一次孤儿清理；这是有意的（表达得出「删掉某一格的图」），代价是每次编辑保存多三条查询。

