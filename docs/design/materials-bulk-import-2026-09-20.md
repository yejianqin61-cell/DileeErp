# 物料清单批量导入（2026-09-20）

用户原话：

> 针对采购模块，物料清单，我们新增一个批量导入物料。我们提供模板，用户填写并上传。模板的 column 口径你来定。

本文记录**模板列口径的取舍**（用户把这一项交给我定，所以要写清依据）与实现边界。

---

## 1. 结论：模板 7 列

| # | 表头 | 必填 | 口径 | 依据 |
|---|------|------|------|------|
| 1 | 物料编码 | 否 | 留空 = 系统按 `MAT-当天日期-序号` 自动生成；自己填则必须唯一（忽略大小写与空格比对） | 沿用「新建物料」弹窗的 `code_mode = auto` 与 `dailyCodePrefix("MAT")`；用户 2026-09-16 对盘点导入的原话是「在新建物料时自动生成一个物料代码」，所以自动生成是主路径 |
| 2 | 物料名称 | **是** | ≤200 字 | `Material.name`（必填列） |
| 3 | 规格型号 | 否 | ≤200 字 | `Material.specificationModel`；与名称、颜色一起构成组合唯一键 |
| 4 | 颜色 | 否 | ≤100 字 | `Material.color`；同上 |
| 5 | 默认单位 | **是** | **单位名称**（如 `米` / `打` / `个`），必须是单位池里已有的**启用**单位；忽略大小写与空格比对 | `Material.defaultUnitId` 是必填外键，而模板里只能写名字；「必须是已有单位」见 §3 |
| 6 | 物料类型 | 否 | `原料` / `成品`，留空 = 原料 | `Material.materialType`（库默认 `raw_material`），与弹窗的下拉同源 |
| 7 | 备注 | 否 | ≤1000 字 | `Material.remark` |

**为什么就这 7 列**：它们正好是 `Material` 表上「人能填」的全部字段，也就是「新建物料」弹窗
（`apps/web/components/bom/material-create-dialog.tsx`）的字段集合。多一列 = 多一个界面上填不了、
只能改库的字段；少一列 = 导入出来的物料与手工新建的不是同一种东西。`id / createdAt / isActive /
deletedAt` 这些是系统字段，不进模板（软删的物料不进导入，见 §3）。

**表头名就是口径，列顺序不绑**：解析按表头名认列（`MATERIAL_HEADER_ALIASES` 收同义词），
操作员挪列、加无关列都不会错位；认不出的列如实回显成「已忽略」，不静默丢。
这一套与「库存盘点导入」「其他应付导入」「花名册导入」完全一致 —— 操作员面对的是同一件事
（下载模板 → 填写 → 上传 → 看逐行错误），不该在物料这一处换一套规矩。

---

## 2. 两条唯一口径都要查，而且必须查**已软删**的记录

物料表有两条唯一约束：

- `materialCode` 单列唯一（`@unique`）；
- `name + specificationModel + color` 组合唯一（`@@unique`）。

组合唯一是**有意**的（迁移 `20260912190000` 的注释）：同名不同规格/颜色必须能并存，
而 `NULL` 在 PostgreSQL 唯一索引里互不相等，所以规格/颜色用空串而不是 NULL 做缺省。
导入侧跟着这个口径走：`materialKey()` 去空格、空值落 `""`，与单条新建**同一个函数**。

**关键坑：唯一索引不看 `deletedAt`。** 软删（`material.delete`）只改 `deleted_at` 与 `is_active`，
索引条目还在。因此：

- 导入查重必须把 `deletedAt != null` 的记录一起读进来，否则「编码被一个已删除的物料占着」
  会在写库那一刻变成 P2002，整批失败且**说不清是哪一行**；
- 命中软删记录时给的是另一句话：说明那条已被删除、编码仍被占用，并给出两条出路
  （换编码 / 留空自动生成；组合冲突则是「先恢复那条物料」）。

这一条是本次实现里最容易漏、后果最烦人的地方，所以单测里各有一条用例专门钉它
（`material-import.test.cjs` 的「编码已存在」「组合已存在」「自动编码跳过被软删的号」）。

---

## 3. 不做的事（以及为什么）

| 不做 | 为什么 |
|------|--------|
| **不自动新建单位** | 单位是主数据，靠一份物料表顺手建出来，结果就是「米 / m / M / 公尺」各占一条（单位名唯一但同义词不唯一）。与盘点导入「产品代码找不到就不自动建档」是同一条纪律：**缺的东西要说出来，让操作员去建**，而不是猜。报错时顺带把单位池现有的单位列在提示里，一次就能改对 |
| **不修改已有物料** | 用户要的是「批量导入物料」＝新增。让导入带 upsert 的后果是「一次误传把主数据改烂，而且没人看得出来」——没有变更前快照、没有逐字段差异。要改请用列表里的「编辑」。撞上已有记录的行走行级错误并指出占用者是谁/编码多少 |
| **不猜物料类型** | 写「半成品」「外购件」这类不认识的词直接报错，不做「非空即成品」之类的兜底：猜错的表现是「以为导进原料池的其实是成品」，而这种错事后没人会去查 |
| **不预检「编码是否曾被删除过」以外的历史** | 审计与快照都在 `audit` 表里，导入只记一条 `material.import`（条数、来源文件名、自动编码条数） |

---

## 4. 实现与验证

### 后端

- `apps/api/src/modules/procurement/material-import.ts`（纯函数，无 Nest/Prisma 依赖）
  - 模板列 / 同义词 / 归一表 / 示例行 / `parseMaterialRows()` / `materialTemplateWorkbook()`
  - 行级校验：必填、库列宽、物料类型枚举、**文件内**编码与组合重复
  - 表头不在第一行也认（文档形态：前 10 行找表头，数据块到第一个空行为止）
- `ProcurementMasterDataService.materialTemplate()` / `importMaterials()`
  - 四段式：解析（纯函数）→ 匹配单位 → 查重（含软删）→ 一个事务里批量建档
  - 自动编码沿用 `dailyCodePrefix` + `nextSequenceCode`：先按平台规则算「下一个」，
    再在批内递增并与库里已有编码核对（不重写「只认纯数字后缀」那套边界）
  - 并发写入撞唯一键 → 409 +「已全部回滚，请重新上传」（事务保证没有半成品）
- `ProcurementMasterDataController`：`GET /materials/import-template.xlsx`、`POST /materials/import`
  - 权限**只要 procurement 模块**，与 `POST /materials` 同一档（批量只是同一个动作的批量入口）；
    声明位置在所有 `materials/:id` 之前，避免静态单段路径被 `:id` 吃掉（仓库里踩过两次的坑）
- 测试：`apps/api/test/unit/material-import.test.cjs`（24 条：表头识别、逐行校验、文件内重复、
  模板自洽、单位匹配、两条唯一口径含软删、自动编码接续、整批失败不写库、文件类型 422）

### 前端

- `apps/web/app/procurement/materials/page.tsx`：新增「批量导入物料」面板
  - 下载模板走 `lib/download`（带鉴权 cookie 的 fetch，并解出中文文件名；`<a href>` 会丢 cookie 变 401）
  - 上传走 multipart `FormData`（不能走 `apiPost`，那会把 body JSON 化）
  - 结果整份留在页面上：条数、逐行错误（行号 / 字段 / 原因）、忽略的列、提示、
    **已新增的物料清单（含自动生成的编码）**
- `apps/web/lib/material-import.ts`：路径、列清单与结果口径（纯函数）
  - `materialImportOutcome()`：**部分成功不许说成全部成功**（判据用 `imported` 而不是后端 `status`，
    因为「全部行被拒」与「一行都没进来」对操作员是同一件事）
  - `materialImportSummary()`：`共 12 行：新增 10 条 / 未导入 2 行 / 其中自动生成编码 3 条`
- 测试：`apps/web/lib/material-import.test.mjs`（4 条）、
  `apps/web/test/material-import-panel.test.tsx`（6 条：模板下载、multipart 形状、结果渲染、部分成功提示、全失败、上传报错不刷列表）

### 顺手修掉的「导入看不见结果」的根因

原 `ValidationPipe` 的 exceptionFactory 只读顶层 `error.constraints`，`@ValidateNested()` 的错误挂在
`error.children` 上 → 嵌套字段校验失败时 `details` 是**空数组**，前端只剩一句「请求参数校验失败」
（recon 记录的 D10）。已抽成 `platform/http/validation-exception.factory.ts` 并递归拍平成
`spec_details[1].quantity` 这样的路径；D10 的护栏用例（`contract-guardrails.test.cjs`）已从
「断言 details 为空」翻转为「断言能定位到 `items[n].xxx`」。详见 `2026-09-20-sales-order-400.md`。
