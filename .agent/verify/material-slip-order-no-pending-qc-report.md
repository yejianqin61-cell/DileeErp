# 领料单导出件补订单号 + 成品质检「所有待质检列表」独立验证报告

- 日期：2026-11-07
- 验证人：verifier（独立验证；**未改任何业务源码/测试**，只写 `.agent/verify/`、`docs/test/results/material-slip-order-no-pending-qc/` 与任务要求的 `tmp/verify-next-build.log`）
- 需求原话：
  1. 「采购板块，领料单的导出件也要有订单号」
  2. 「成品提交质检入库，成品质检页面要显示所有待质检列表」
- 设计文档：[`docs/design/material-slip-order-no-and-finished-goods-pending-qc-2026-11-07.md`](../../docs/design/material-slip-order-no-and-finished-goods-pending-qc-2026-11-07.md)
- 结论：**通过**（发现 0 个实现缺陷；全部验证点通过，既有测试没有被放宽）
- 收尾复核（2026-11-07 二次窄范围重验，T24 列宽调整后）：只重跑 C（真实 Chromium），**51/51** 通过，console error 0、pageerror 0；「已检数量」「待检数量」表头**完整可见、不再省略**；`pending-list.png` / `pending-empty.png` / `qc-dialog-preselected.png` 已按当前 CSS 重拍（详见 §3.1 末尾）。

| 验证点 | 结果 |
| --- | --- |
| A. ExcelJS 真解析导出件（单张领料/补料、混合批量、docs/samples 两张样例、打印件同位置） | **38/38** 断言通过 |
| B. 独立假 Prisma 探针：`listSubmissions` 的 `inspectedQuantity` / `pendingQuantity` | **20/20** 断言通过 |
| C. 真实 Chromium（`page.route` mock，不连数据库） | **51/51** 断言通过（含 2026-11-07 收尾复核新增的列宽/表头 6 条；原 45/45）；4 场景；console error **0**；pageerror **0** |
| D. 门禁 | 全部 exit 0：API 单测 **2857/2857**、web lib **427/427**、web 组件 **75 文件 / 1253 tests**、typecheck（api+coding-worker+web）、覆盖守卫 **12/12**、`next build` **EXIT=0**（日志见 `/production/material-issues`、`/qc/finished-goods`） |
| E. 偷工减料/放宽测试 | 未发现：4 个测试文件 **测试数只增不减**、断言数只增不减（见 §6），diff 里唯一的「改」是新增表格后把断言范围收窄到订单详情块（必要修正，未丢意图） |

> 本次改动只涉及 4 个业务源码文件 + 1 个样例生成脚本 + 2 个样例 xlsx + 3 个既有测试 + 1 个新增测试 + 设计文档；**没有** schema/迁移、没有新增/修改 API 路由（`finished-goods-qc.controller.ts` 与 `material-slip-export` 控制器均未改）。

## 1. A. 导出件独立核验（ExcelJS 真解析 dist 真实输出）

脚本：[`.agent/verify/material-slip-order-no-export-check.mjs`](./material-slip-order-no-export-check.mjs)（`require apps/api/dist` 的 `MaterialSlipExportService` + 自造 Prisma/AuditActor 桩，**不信任实现者测试**）。结果 JSON：[`material-slip-order-no-export-results.json`](./material-slip-order-no-export-results.json)。
为了证明订单号不是写死的，两份自造单据用了**两个不同的销售订单号**：领料单 `SO-20261107-0007`、补料单 `SO-20261107-0008`。

### 1.1 单张领料单（真实 xlsx 逐格读）

| 单元格 | 实测 | 说明 |
| --- | --- | --- |
| 工作表名 | `MI-20261107-AAAA1111` | = 单据号，仅 1 张表 |
| `A1` | `【领料单】` | 标题/状态未变 |
| `A3/B3`、`A4/D4`、`B5/D5` | 生产单号：/ MO-20261107-0001；颜色：/ MI-20261107-AAAA1111；500 把 / 张三 | **既有字段位置与值不变** |
| `G5` / `H5` | `订单号：` / `SO-20261107-0007` | 新增订单号 |
| `H5:J5` | 合并区存在，`I5`/`J5` 的 master 都是 `H5` | 值只在主格，不是独立单元格 |
| `H3:J3`、`H4:J4` | 仍在 | 模板第 4 组跨列写法未动 |
| 第 6 行 | `序号/产品名称/产品代码/规格型号/颜色/单位/配料数量/已领数量/本次领料量/余下数量` | 明细表头 10 列原样 |
| 第 10 行 | `A10 = 小计` | 3 行明细 → 小计仍在「表头+明细行+1」 |
| 第 11 行 | `A11 = 备注：第一批领料，裁剪工序`，合并 `A11:J11` | 备注行未挪 |

### 1.2 单张补料单

| 单元格 | 实测 |
| --- | --- |
| 工作表名 / `A2` | `MC-20261107-BBBB2222` / `【补料单】` |
| `E7` / `F7` | **`订单号：` / `SO-20261107-0008`** |
| `G7` / `H7` | **`补料原因：` / `伞布原始坏片 12 米`（位置不挪）** |
| 第 8 行 | `序号/图片/产品名称/产品代码/规格型号/颜色/单位/补领数量`（8 列原样，图片仍第 2 列） |
| 小计 | `A10 = 小计` |

### 1.3 批量导出（`exportSlips`，与 `GET production/reports/material-slips.xlsx` 同一实现）

- count = 2；两张工作表名 = 各自单据号；
- 领料单表：`G5=订单号：`、`H5=SO-20261107-0007`、第 6 行 10 列；
- 补料单表：`E7=订单号：`、`F7=SO-20261107-0008`、`G7=补料原因：`、`H7` 原因、第 8 行 8 列；
- **两张单的订单号互不串**（各取自己的销售订单号，不是同一个常量）。

### 1.4 `docs/samples` 两张样例必须已重生成（不是旧样例）

- `docs/samples/领料单-样例.xlsx`（7858 B，10:50:45）：`G5=订单号：`、`H5=DL260001`；表头第 6 行 10 列、`A10=小计`；
- `docs/samples/补料单-样例.xlsx`（7565 B，10:50:45）：`E7=订单号：`、`F7=DL260001`、`G7=补料原因：`、`H7=伞布原始坏片 12 米，需补领`；表头第 8 行 8 列、`A10=小计`；
- **样例 = 当前导出件**：用 `scripts/make-export-samples.cjs` 的同一组固定样例数据重新导出，**16 行 × 12 列逐格全等**、合并区集合全等（领料单与补料单都比对过）。

### 1.5 打印件与导出件「同位置同顺序」

打印件纯函数 `materialSlipHeadRows`（`apps/web/lib/material-slip-print.ts`）的输入用 **dist `buildDocument` / `buildReplenishmentDocument` 组装的同一份单据**，逐组比对：

- 领料单：打印件三行 × 4 组的标签/值序列 == xlsx 第 3/4/5 行对应格序列（完全相等）；
- 补料单：打印件三行 × 4 组 == xlsx 第 5/6/7 行（完全相等）；
- 领料单第 3 行第 4 组 = 订单号；补料单第 3 行第 3 组 = 订单号、第 4 组 = 补料原因；
- 订单号为空时该组仍占位（标签在、值空串），与导出件空格一致。

## 2. B. `listSubmissions` 新字段独立探针（自造 Prisma，不跑实现者单测）

脚本：[`.agent/verify/finished-goods-qc-submission-progress-probe.mjs`](./finished-goods-qc-submission-progress-probe.mjs)；结果 JSON：[`finished-goods-qc-submission-progress-results.json`](./finished-goods-qc-submission-progress-results.json)。

| 用例 | 实测 |
| --- | --- |
| active 40 + corrected 60，送检 100 | `inspectedQuantity="40"`（**corrected 不计**）、`pendingQuantity="60"` |
| 只有 corrected 60 | 已检 `"0"`、待检 `"100"` |
| 已检 150 > 送检 100（历史脏数据） | 已检 `"150"` 原样、**待检钳到 `"0"`**（不是 -50） |
| 空 `qcRecords` | 已检 `"0"`、待检 = 送检量 `"100"` |
| active 0.1 + 0.2，送检 100 | 已检 `"0.3"`、待检 `"99.7"`（Decimal 无浮点尾差） |
| 类型 | 两个新字段都是 **string** 十进制 |
| 原字段 | 逐字段不变（`orderNo/status/submittedQuantity/submissionDate/qcRecords/unit/...`）；`qcRecords` 原样带出（corrected 记录仍在、顺序未变）；只多 2 个键；**入参行对象未被就地修改** |
| 查询形状 | `where.deletedAt=null`、`include.qcRecords.where.deletedAt=null, orderBy.inspectionDate=asc`、`include.unit=true`、`orderBy.updatedAt=desc`；传 orderNo 时 `where.orderNo` 生效；软删送检单不返回 |
| 写库 | 0 次（写方法一调用就抛错） |

## 3. C. 真实 Chromium（不连数据库）

脚本：[`.agent/verify/material-slip-order-no-pending-qc-visual-check.mjs`](./material-slip-order-no-pending-qc-visual-check.mjs)；`page.route` 拦 `/api/v1/**`；证据：`docs/test/results/material-slip-order-no-pending-qc/`（`summary.json` + 5 张 PNG）。
4 个场景：`qc-pending-list` 29/29、`qc-server-fields-wiring` 6/6、`qc-pending-empty` 6/6、`material-slip-print` 10/10；**console error 0、pageerror 0**、导航全部 HTTP 200。（第一次验证 45/45；2026-11-07 收尾复核因 T24 列宽调整补了 6 条列宽/表头断言，重跑 51/51。）

### 3.1 `/qc/finished-goods` 待质检（全部订单）

- **无需选订单**：首屏即出现「待质检（全部订单）」块；首屏两个列表请求（`/finished-goods/qc/sources`、`/finished-goods/inspection-submissions`）都**不带 order_no**，也没有任何订单详情请求。
- **行集**：mock 6 张送检单（submitted 2 / inspecting 1 / draft 1 / qc_completed 1 / cancelled 1）→ 页面只显示 **3 行**，`draft`/`qc_completed`/`cancelled` 的单号在块内**完全不出现**；「共 3 张」。
- **排序**：送检日期升序、同日送检单号升序 → `FGIS-20261101-0001 → FGIS-20261101-0003 → FGIS-20261102-0002`。
- **列**：前 9 列 `送检单/订单号/生产单/成品/来源/送检数量/已检数量/待检数量/状态`，随后 `创建人/最后修改人`（auditColumns），最后一列 `操作`，共 12 列。
- **每行内容**（实测 DOM 文本）：行 1 `SO-1001 / MO-SO-1001 / 自动雨伞 / 22寸×8K / 成品入库通知 / 100 把 / 0 / 100 / 待质检 / [录入质检]`；行 2 来源 `外加工回厂`；行 3 `200 把 / 80 / 120 / 质检中`。
- **列宽（2026-11-07 收尾复核后的 T24）**：10 列写了声明宽度 **`9/8/9/11/8/7/8/8/6/10%`，合计 84%**；渲染后这 10 列实际占表宽 **930.5 / 1110 = 83.8%**（±2% 断言通过；另 16% 由无宽度的 audit 两列均分，实测各 88.7px）。
  - 复核点：web-dev 把「已检数量」「待检数量」两列由 6% 抬到 8%（四个长文本列各让 1%）后，1440px 下两个表头**完整可见**：实测宽各 **88.6px**、`scrollWidth ≤ clientWidth`（无省略号），文本完整为「已检数量」「待检数量」（截图为 `pending-list.png`，肉眼可见不再是「已检…/待检…」）；其余表头文本也完整。
  - 旧值（第一次验证时）为 `10/8/10/12/9/7/6/6/6/10%`（已检/待检各 6%，1440 下两张表头被省略）；新值合计仍是 84%，行内容/排序/共 N 张/预选/双击/空态全部复验通过。
- **行内「录入质检」**：点行 3 的按钮 → 弹窗标题 `录入成品质检：SO-2002`；「订单内送检批次」触发器显示 `FGIS-20261102-0002 / 200 把 / inspecting`；展开下拉后该项 `aria-selected=true / data-state=checked`（**预选正确**）。
- **双击行**：出现「订单详情：SO-1001」，且只发出 3 个带 `order_no=SO-1001` 的请求：`/finished-goods/qc/sources`、`/finished-goods/inspection-submissions`、`/finished-goods/qc-records/available-inbound-sources`。
- **服务端字段（防前端重算）**：给一条「送检 200 / inspectedQuantity 66 / pendingQuantity 42」的不一致哨兵数据，页面显示 **66 / 42**（若前端自己算会是 0 / 134 或 200）→ 已检/待检确实来自服务端字段。
- **空态**：只有 draft/qc_completed/cancelled 时显示「暂无待质检的成品送检单」+ 提交指引 + 「共 0 张」、0 行。
- **证据截图（收尾复核已按新列宽重拍）**：`pending-list.png`（新列宽、两表头完整）、`pending-empty.png`、`qc-dialog-preselected.png` 均为 2026-11-07 11:11–11:12 生成；`summary.json` 内 `verificationNotes` 记录了本次复核的列宽与表头实测值。

### 3.2 `/production/material-issues` 打印件（领料单 / 补料单）

| 单据 | 纸头第 3 行（DOM 单元格顺序） | 结论 |
| --- | --- | --- |
| 领料单 | `生产数量： / 500 把 / 操作人： / 张三 / 操作时间： / 2026-11-07 10:30 / 订单号： / SO-1001` | 订单号在**第 3 行第 4 组**；既有三组位置未挪；明细表头 10 列原样 |
| 补料单 | `操作人： / 张三 / 操作时间： / 2026-11-07 11:10 / 订单号： / SO-2002 / 补料原因： / 伞布原始坏片 12 米` | 订单号在**第 3 行第 3 组**、补料原因仍是**第 4 组**；明细表头 8 列原样（图片仍第 2 列） |

截图：`print-issue.png`、`print-replenishment.png`（肉眼可见订单号格子与导出件一致）。

## 4. D. 门禁（全部 exit 0）

| 门禁 | 命令 | 原始数字 |
| --- | --- | --- |
| API 全量单测（含 build） | `npm run test:unit:api` | **tests 2857 / pass 2857 / fail 0**（duration 23394.742ms，exit 0） |
| Web lib | `apps/web npm run test:lib` | **tests 427 / pass 427 / fail 0**（exit 0） |
| Web 组件 | `apps/web npm run test:components` | **Test Files 75 passed / Tests 1253 passed**（152.74s，exit 0） |
| Typecheck | `npm run typecheck`（api + coding-worker + web） | 三个 workspace 均 `tsc --noEmit`，**exit 0** |
| 覆盖守卫 | `node --test apps/web/lib/audit-columns-coverage.test.mjs apps/web/lib/table-width-coverage.test.mjs` | **tests 12 / pass 12 / fail 0**（exit 0） |
| Web 生产构建 | `npm run build --workspace=@dilee/web`（输出重定向 `tmp/verify-next-build.log`） | **BUILD_EXIT=0**；`✓ Compiled successfully in 7.4s`；日志含 `○ /qc/finished-goods 5.52 kB`、`○ /production/material-issues 9.43 kB`；仅有既有的「multiple lockfiles / workspace root」warning（与本轮改动无关） |

## 5. 关键词对照（需求 → 证据）

| 需求 | 证据 |
| --- | --- |
| 领料单导出件有订单号 | A：G5=标签、H5=订单号、H5:J5 合并；批量导出同；样例已重生成 |
| 补料单导出件有订单号（且补料原因不挪） | A：E7/F7、G7/H7 原样；C：打印件同位置 |
| 打印件与导出件同位置 | A：打印件三行×4 组 == xlsx 逐格；C：打印弹窗 DOM 逐格 |
| 成品质检页显示所有待质检列表 | C：首屏跨订单 3 行、无需选订单、共 3 张、不含 draft/completed/cancelled |
| 列表含已检/待检 | B：服务端口径（active 合计、钳 0、字符串）；C：DOM 显示服务端字段（哨兵 66/42） |
| 行内「录入质检」预选该批次 | C：弹窗标题 + 触发器文本 + 下拉选中态 |
| 双击进订单详情 | C：3 个按 order_no 的请求 + 「订单详情：SO-1001」 |
| 空态 | C：文案 + 指引 + 共 0 张 |
| T24 十列 84% | C：声明宽度 10 列 **9/8/9/11/8/7/8/8/6/10 = 84%**、渲染占比 ≈83.8%、12 列结构（audit 两列无宽度）；「已检数量/待检数量」表头完整可见（收尾复核 51/51） |

## 6. E. 既有测试是否被放宽（对比 HEAD）

用 `git show HEAD:<file>` 与工作区对比「测试条数 / 断言条数」：

| 文件 | tests（HEAD → 现在） | 断言/expect（HEAD → 现在） |
| --- | --- | --- |
| `apps/api/test/material-slip-export.test.cjs` | 12 → **12** | 98 → **113** |
| `apps/web/lib/material-slip-print.test.mjs` | 4 → **5** | 15 → **22** |
| `apps/web/test/finished-goods-qc-panel.test.tsx` | 16 → **21** | 94 → **112** |
| `apps/api/test/unit/finished-goods-qc-submission-progress.test.cjs` | 新文件 | 8 tests / 32 断言 |

- 没有任何测试被删除；断言数全部上升。
- 被「修改」的既有断言只有两类，均属必要修正、没有丢意图：
  1. `material-slip-print.test.mjs` 中补料单第 3 行从 3 组变 4 组，原 `[2][2]` 改为 `[2][3]` 指向补料原因（同一断言，索引随新组移动）；
  2. `finished-goods-qc-panel.test.tsx` 中 `getAllByTestId("data-table")` 的全局索引改为 `detailBlock()` 内取（新表加到页面顶部后的必要作用域收窄）；`queryByTestId("data-table")` 同理限定在详情块内。
- 新测试覆盖：导出订单号（单张/批量/草稿/位置不挪）、打印件位置、listSubmissions 四类边界、待质检行集/排序/预选/双击/空态。

## 7. 观察项 / 未覆盖点（不构成缺陷）

1. **待质检表长文本省略（表头已完整）**：1440px 下正文里「送检单」列（9%）显示为 `FGIS-202…`、「生产单/成品/来源」等长文本列也是省略 + `title` 悬停看全文——设计文档 §2.2 明确这是 7%~11% 的刻意取舍，与既有 T21~T23 表同一套规则，不判缺陷。**表头已不再省略**：收尾复核把「已检数量/待检数量」由 6% 抬到 8% 后，两张表头实测宽各 88.6px、`scrollWidth ≤ clientWidth`，完整显示（旧截图里的「已检…/待检…」已消失）。
2. **列顺序**：实际共 12 列（9 业务 + audit 的创建人/最后修改人 + 操作放在最后）。设计文档 §2.2 的 10 列表把「操作」列为第 10 列、audit 两列是额外 16%，两种描述在「10 列声明宽度 = 84%」上一致；实现把操作放在 audit 之后，与本面板既有三张表一致。不判缺陷。
3. **无真实数据库**：本机无 PostgreSQL/docker，`listSubmissions` 用假 Prisma 验证（行为口径与字符串精度都覆盖）；真实 Prisma 的 `include qcRecords` 语义与改动前完全相同（改动只是在返回前读 `row.qcRecords` 求和），风险低。待质检页面的真实接口联调未做（环境限制）。
4. `/production/material-issues` 页头动作按钮在 1440px 下竖排挤在一起 —— 既有布局现象，与本次改动无关。
5. 样例 xlsx 的二进制字节未与「重生成结果」逐字节比对（zip 时间戳会变），改为**逐格 + 合并区**比对（对内容等价性足够）。

## 8. 复现步骤（完整命令）

```powershell
cd C:\Users\USER\Desktop\Dilee

# 1) 门禁（会先 build API；不需要数据库）
npm run test:unit:api
cd apps\web; npm run test:lib; npm run test:components; cd ..\
npm run typecheck
node --test apps/web/lib/audit-columns-coverage.test.mjs apps/web/lib/table-width-coverage.test.mjs

# 2) A / B（不需要 dev server；require dist + 假 Prisma）
node .agent\verify\material-slip-order-no-export-check.mjs
node .agent\verify\finished-goods-qc-submission-progress-probe.mjs

# 3) C. 真实浏览器（先起 dev server，端口 3111；跑完关掉）
npm run dev --workspace=@dilee/web -- -p 3111
node .agent\verify\material-slip-order-no-pending-qc-visual-check.mjs
#    结束后关闭 dev server 并确认端口释放：
Get-NetTCPConnection -LocalPort 3111 -State Listen -ErrorAction SilentlyContinue

# 4) Web 生产构建（须先关掉 dev server；输出重定向到 tmp/verify-next-build.log）
npm run build --workspace=@dilee/web *> tmp/verify-next-build.log
$LASTEXITCODE   # 期望 0；日志里应出现 /qc/finished-goods 与 /production/material-issues
```

- 三个验证脚本的 JSON 结果：`.agent/verify/material-slip-order-no-export-results.json`、`.agent/verify/finished-goods-qc-submission-progress-results.json`、`docs/test/results/material-slip-order-no-pending-qc/summary.json`。
- 证据截图：`docs/test/results/material-slip-order-no-pending-qc/{pending-list,pending-empty,qc-dialog-preselected,print-issue,print-replenishment}.png`。
- 构建日志：`tmp/verify-next-build.log`（11274 B；`✓ Compiled successfully`，仅 multiple-lockfiles warning）。
