# 销售单行图：一条物料最多 3 张（2026-11-05）

## 1. 用户需求

> 「现在，销售单那边，一条物料支持导入 3 张图片，现在只有 1 张。改一下」

上一轮（2026-11-04）交付的是「每种一张图」：材料明细 18 格、每格「再加一款」行、「其它」行、
细分明细（伞布/伞头）行，每个位置都只能挂 **1** 张。本轮把每个位置扩到最多 **3** 张。

用户拍板：

| 决策 | 内容 |
|------|------|
| 范围 | **所有可插图的行/格**都升到 3 张（18 格、再加一款行、其它行、细分明细行）——界面与数据一致，不用记哪类行只能 1 张 |
| 导出 | **全部印**，且「带图片导出」弹窗里**逐张可勾选**（默认全选） |

## 2. 数据模型（`apps/api/prisma/schema.prisma`）

三个位置都扩到 3 张，**旧数据原样可用**（第 1 张仍是原来的 `image_id`，不需要回填）：

| 位置 | 存储 | 说明 |
|------|------|------|
| 18 个材料格 | `sales_order_slot_images`：新增 `slot_index`（0/1/2），唯一键 `(sales_order_id, spec_key, slot_index)` | 一行 = 一格的一张图；历史行 `slot_index = 0` 正好是第 1 张 |
| 「再加一款」/「其它」行 | `sales_order_material_extras`：新增 `image_id_2`、`image_id_3`（可空外键，ON DELETE SET NULL） | 第 1 张仍是 `image_id` |
| 细分明细行 | `sales_order_spec_details`：新增 `image_id_2`、`image_id_3` | 同上 |

为什么不用 `uuid[]` 数组列：三张图都要能按 id 回读字节、也要能算「这一单还有没有活行引用它」
（保存末尾清理孤儿图）；可空外键 + 索引让这两件事继续走同一条路径，数组列没有外键约束、
清理要扫数组，是更难维护的写法。

迁移：`apps/api/prisma/migrations/20261105103000_sales_order_row_images_x3/migration.sql`
（只加列/索引/唯一键；`DROP INDEX` 掉旧的「一格一张」唯一键）。**部署前必须 `npm run db:migrate:deploy`。**

## 3. 接口契约

### 3.1 保存（`POST /sales-orders` / `PATCH /sales-orders/:id`）

一律用**数组**表达，最多 3 个，顺序 = 用户看到的顺序（去重后保持原顺序）：

```jsonc
{
  "spec_details":   [{ "group_name": "伞布明细", "name": "…", "image_ids": ["img-1", "img-2"] }],
  "material_extras":[{ "label": "弹簧", "material_id": "…", "image_ids": ["img-1", "img-2", "img-3"] }],
  "slot_images":    [{ "spec_key": "canopy_spec", "image_ids": ["img-a", "img-b"] }]
}
```

- 兼容旧形状：`image_id`（单张）仍接受，等同于 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。
- `[]` = 这一行/这一格没有图；`slot_images` 整块出现就按「整块替换」处理（没列出的格 = 清空）。
- 超过 3 个 → 422 `SALES_ORDER_IMAGE_LIMIT`（`message`: 「一行/一格最多 3 张图片」，
  `details`: `[{ scope, key, count }]`）。
- 图片 id 归属校验沿用 `assertOrderImages`：不存在/已删/不属于本单 → 422 `SALES_ORDER_IMAGE_NOT_FOUND`。
- `empty row` 判定：`image_ids.length > 0` 的行不算空行（上一轮已如此，只是从单值变数组）。

### 3.2 详情（`GET /sales-orders/:id`）

保持 Prisma 行形状（不额外拼数组），前端从三个关系读：

- `specDetails[]`：`imageId` / `imageId2` / `imageId3` 标量 + `image` / `image2` / `image3` 摘要；
- `materialExtras[]`：同上；
- `slotImages[]`：`specKey` / `slotIndex` / `image` 摘要，`orderBy: [specKey asc, slotIndex asc]`。

摘要字段仍是五字段 `SALES_ORDER_IMAGE_SUMMARY`（id/width/height/byteSize/sha256）。

### 3.3 返单预览 / 复制快照（`reorderPreview` / `copySnapshot`）

每行带**数组**（请求键形状）：

```jsonc
{
  "image_ids": ["img-1", "img-2"],
  "images":    [{ "id": "img-1", "width": 1600, "height": 1200, "sha256": "…" }, …]
}
```

第 1 张同时镜像到旧的 `image_id` / `image` 键（快照与老前端仍可读）；数组为空时两者都不带。
`slot_images` 行：`{ spec_key, image_ids, images }`。

保存到新单时 `bindOrderImages` 按数组**逐张克隆字节**并重映射 id（返单/复制 = 新单自己的图）。

### 3.4 版本快照

`spec_details[].image_ids`、`material_extras[].image_ids`、`slot_images[].image_ids` 原样进快照
（快照只记指针不记字节，与上一轮同一口径）。

### 3.5 工艺单导出（`sales-order-export.service.ts`）

- **候选（`GET /sales-orders/:id/export-images`）每张图一条**：
  - `spec_key` 是**唯一种类键**：第 1 张 = 原键（`rib_spec` / `extra:<id>` / `detail:<id>`），
    第 2/3 张 = `原键#2` / `原键#3`；
  - 新增 `base_key`（不带后缀的键）与 `image_slot`（0/1/2）；
  - `label` 第 2/3 张追加「（第 2 张）」「（第 3 张）」，避免弹窗里三条一模一样的文字；
  - `image_url` / `image_id` / `image_source` 按该张图给（行图优先、物料图兜底只影响第 1 张：
    有行图时只用行图，没有行图时第 1 条候选是物料图、没有第 2/3 条）。
- **multipart 字段名 = 候选的 `spec_key`**（天然唯一）。服务端解析 `#n` 后缀定位「哪一格第几张」；
  键必须是这一单真实存在、且那一格确实有第 n 张图，否则 422（沿用 `unsupportedImage`）。
- **底部图片区**：材料行（18 格 + 再加一款 + 其它）每张选中的图**各占一格**，按行顺序、再按第 1→3 张；
  标签「栏位名：物料编码 名称（第 n 张）」。
- **细分明细行**：该行所有选中图都印在 C 列（「图片」列）**竖排**，每张仍按
  `detailImageBoxFor` 缩到 ≤56px；行高 = max(文字行高, 各图高度之和 + 2px 间隙)，
  不足 44 磅按 44 磅（沿用 `DETAIL_IMAGE_ROW_HEIGHT`）。分组横幅的「共 N 张图」按**张数**数。
- 单张上限与总量上限不变（2MB / 12MB，超出按原错误提示让用户少勾）。

## 4. 前端（`apps/web`）

- `lib/sales-order-spec.ts`：
  - `RowImageMeta` 不变（单张摘要）；新增 `RowImages = RowImageMeta[]`（最多 3）；
  - `SlotImages = Record<string, RowImageMeta[]>`（原来是 `RowImageMeta | null`）；
  - `rowImagesFrom(value)`：认详情三关系形状（`image`/`image2`/`image3`，`imageId`/`imageId2`/`imageId3`）
    与复制/返单的 `images` / `image_ids` 形状；
  - `slotImagesFromOrder` 按 `slotIndex` 聚成数组；`slotImagesPayload` → `[{ spec_key, image_ids }]`；
  - `materialExtrasPayload` / `specPayload` 行带 `image_ids`（空数组不带键）；
  - 空行判定改为「有任意一张图就不是空行」。
- `components/sales/sales-order-row-image.tsx`：
  - 最多 3 个 36px 缩略图依次排开；每张可**换图**（点缩略图选文件）与**删除**（缩略图下方的「删」）；
  - 未满 3 张时显示「上传图片 / 再加一张」；满 3 张时按钮禁用并提示「已满 3 张」；
  - 没有归属单（新建单未保存）时仍整体禁用，提示不变；
  - 「是否同时写入物料清单」只在**上传这一行的第 1 张**、且引用了没有图的物料时问一次
    （3 张都问会变成打扰；物料清单本身也只有一张图）。
- 编辑器四处（18 格 / 再加一款 / 其它 / 细分明细）接数组；保存载荷与返单/复制回填按 §3.3。
- 导出弹窗（`components/sales/production-sheet-export-dialog.tsx` + `lib/production-sheet-image.ts`）：
  候选每张一条（`image_slot`/`base_key`），默认全选；勾选后 multipart 字段名 = `spec_key`（含 `#n`）。
  「本单可导出的图片 N 张」按张数算。

## 5. 测试

- `apps/api/test/unit/sales-order-row-images-x3.test.cjs`（新）：保存 3 张（三处都测）、超过 3 张 422、
  兼容旧 `image_id`、详情三关系、返单/复制逐张克隆与 `image_ids` 形状、孤儿清理认第 2/3 张、
  slot 的 `slot_index` 复活/清空。
- `apps/api/test/unit/sales-order-row-image-export.test.cjs`（既有，扩展）：候选每张一条 + `#2/#3` 键、
  底部图片区 3 张都印、明细行 3 张竖排且行高变高、无行图时只有物料图一条、伪造 `#2` 键被拒。
- 既有 API 单测（`sales-order-row-images`、`sales-order-copy`、`sales-order-reorder`、`sales-order-dto`、
  `sales-order-spec`、`sales-order-row-image-export`）随契约更新；不许改业务断言来「绕过」。
- Web：`lib/sales-order-spec.test.mjs`（数组回填/载荷/空行）、`test/sales-order-editor.test.tsx`
  （3 张上传/换/删/载荷）、`test/sales-order-material-extra.test.tsx`、`test/sales-production-sheet.test.tsx`
  （逐张候选与默认全选）、`lib/production-sheet-image.test.mjs`。

## 6. 不做 / 边界

- 不做「拖动排序」：顺序 = 上传顺序；换图是替换同一位置，不改变顺序。
- 不提供 DELETE 图片端点（沿用上一轮：保存末尾清理本单无引用图片）。
- 物料清单本身仍只有 1 张图（「同时写入物料清单」是覆盖那一张，不是追加）。
- 生产单/BOM 行仍没有图片（上一轮边界不变）。
- 本机没有 PostgreSQL：迁移只写 SQL、`prisma validate`/`generate` 通过；真库迁移与并发由部署时验证。

## 7. 验收

1. 编辑既有单：18 格任一格可传 3 张、缩略图并排、可逐张换/删、保存后重开顺序不变；
   「再加一款」「其它」、细分明细行同样。
2. 返单/复制：3 张图都跟到新单，字节是新单自己的（删原单不影响新单）。
3. 工艺单导出：弹窗里每张一条（第 2/3 张有标注）、默认全选；导出件底部图片区 3 张都在，
   明细行 3 张竖排在该行 C 列、行高够、不压字。
4. API 单测全绿；web lib/组件单测全绿；typecheck、next build 通过。
