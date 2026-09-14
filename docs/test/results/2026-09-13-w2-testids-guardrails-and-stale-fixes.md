# W2 执行结果（data-testid 插桩 / 契约护栏 / 路由差集）+ 4 条陈旧集成用例修复

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 对应阶段：`docs/test/01-test-master-plan.md` §5.1 **W2**，外加"接手 4 条陈旧集成用例"
- 环境：Windows 11 / PowerShell 5.1 / Docker 29.7.2 / Node v24.15.0
- 测试库：`dilee_test` + `dilee_test_01..04`

---

## 1. 结论

| 项 | 状态 |
| --- | --- |
| **4 条陈旧集成用例** | ✅ **全部修复**，集成层 4/9 → **9/9 全绿** |
| **S6** `data-testid` 插桩 | ✅ 30 个生产文件 + 21 个页面根钩子；新增 13 条渲染级组件测试 |
| **S11** 前后端路由差集 | ✅ 4 条断言；实测**零不一致**（此前 recon 列为 U8 未验证） |
| **S12** 契约护栏 | ✅ 9 条，把 D2/D7/D8/D9/D10 五个已知缺陷固化为"修复即变红"的护栏 |

**累计测试规模**：单元 435（后端）+ 108（前端 lib）+ 25（前端组件）= **568**；HTTP 契约 **19**；集成 **9**；E2E 2/5。

---

## 2. 实跑证据

| 命令 | 结果 | 退出码 |
| --- | --- | ---: |
| `npm run test` | **568 通过 / 0 失败** | **0** |
| ├ `test:unit:api` | 435 通过 | 0 |
| ├ `test:unit:web` → lib | 108 通过 | 0 |
| └ `test:unit:web` → components | **25 通过**（W2 前 12） | 0 |
| `npm run test:integration` | **9 通过 / 0 失败**（W2 前 5/9） | **0** |
| `npm run test:api` | **19 通过 / 0 失败**（W2 前 10） | 0 |
| `npm run typecheck` | 通过 | 0 |
| `npm run build --workspace=@dilee/web` | 通过（23 条路由） | 0 |
| `npx playwright test` | **2 通过 / 3 失败** | 1 |

**CI `chain` 门禁现状**：集成与 HTTP 契约已全绿；**唯一红项是 3 条 E2E spec**（原因见 §5，属 P5 范围）。

---

## 3. 4 条陈旧集成用例：修复明细

修复原则：**不弱化原有断言意图**；凡是"测试预期"与"当前领域规则"冲突的，先把规则读清楚再决定改谁。

| # | 用例 | 原失败原因 | 处理 |
| --- | --- | --- | --- |
| 1 | `procurement.inbound.post_generates_inventory_and_a_single_payable_source` | 手写的通知行 `status="acknowledged"` 没有与入库单关联，过账必然 422（`INBOUND_NOTICE_NOT_ACKNOWLEDGED`） | **整体改用 W1 夹具 + 真实 service**：`createFromInspection` → `acknowledge`（它会创建并回写 `inboundNoticeId`）→ `post`。原断言全保留，并补充 order_no 贯穿、应付状态、审计事件存在性 |
| 2 | `production.daily-reports.calculates-progress-payroll-and-alert-lifecycle` | 三处：① 薪资来源被断言"删除后变 null"（现值语义是**原地重算**而非删除）② 同工序同日无幂等键的登记是**合并累加**并递增 version，而非新建行 ③ 因此 `expected_version` 也已过期 | 按真实语义重写：删除后断言来源**仍在**且数量/金额/快照按剩余日报重算；合并路径显式断言（`extra.id === first.id`、version 2）；乐观锁用当前版本成功、过期版本被拒；撤回后累计归零且超单告警回落为 `recovered` |
| 3 | `production.order.creates_from_confirmed_order_and_requires_operations_before_start` | 建单会自动补「包装」收尾工序（`production-orders.service.ts:99`），于是 `PRODUCTION_OPERATIONS_REQUIRED` 不再被触发 | 拆成两段互不矛盾的验证：**A** 把工序置为 `cancelled` 后启动 → 守卫仍然生效；**B** 另建补单走正常路径 → 启动 + 包装工序被顺延到末尾。另新增"同一销售订单不允许第二张标准主生产单"的规则断言 |
| 4 | `production.order.operation.target-and-unit.patchable-with-lock-and-validation` | 自动补齐的包装工序占用 `sequence_no = 1`，手工 `addOperation(sequence_no: 1)` 撞唯一约束 | 改用 `addOperations` 批量接口（序号由服务端 `max+1` 分配）；完工前把包装工序置 `cancelled`（完工要求所有非取消工序达标，`:268-270`） |

### 修复过程中新增的两条夹具能力

- `fx.productionPrerequisites()`：只建**前置数据**（物料/销售/BOM/车间/工序），不建生产单。
  **为什么必须单独有它**：`productionChain()` 会先把主生产单建掉，而一个销售订单只允许一张标准主生产单，所以凡是要自己调用 `ProductionOrdersService.create()` 的用例，用 `productionChain()` 必然 409。
- 清理的阶段三改为**由 Prisma DMMF 运行时派生**「挂在带 `orderNo` 父表下、自身无 `orderNo` 的子表」。
  起因：`productionOrderOperation` 既无 `order_no`（逃过 orderNo 清扫）又由 service 创建（工厂拿不到句柄），残留后以外键阻塞父表，导致**整条链清不掉**。手工清单已经漏过两次（先是 `salesOrderVersion`，再是它），改为派生后 schema 加表自动跟上。

---

## 4. W2 交付明细

### 4.1 S6 `data-testid` 插桩

**共享原语**（一套钩子覆盖所有页面）：
`action-dialog` / `action-field-<字段名>` / `action-dialog-error` / `-submit` / `-cancel`；`data-table` + `data-table-row`；`loading-state` / `error-state` / `error-state-retry` / `empty-state`；`toast-region` + `toast-item`；`searchable-select*`；`multi-checkbox-select*`；`app-main` / `app-nav` / `nav-link-<模块>`。

**认证**：`page-login`、`login-form`、`login-username`、`login-password`、`login-submit`、`login-error`。

**21 个页面根**：`page-dashboard` … `page-reports`（完整清单见插桩提交）。

**E2E 触点**：`page-production`、`production-create-order`、`production-order-table`、`production-add-operation`、`production-add-location`；日报面板 `daily-reports-panel`、`operation-report-form`、`operation-report-draft-table`、`operation-report-save`、`employee-report-add`、`employee-report-table`、`employee-picker*`、`daily-alert-table`。

**新增 13 条测试**（`apps/web/test/testid-contract.test.tsx` 10 条**真实渲染并查询 DOM**；`testid-pages.test.ts` 3 条为**约定 lint**，已在文件内显式标注"不是行为测试"——避免重现 recon 批评过的"源码正则冒充行为测试"）。

**一处必要的视觉保障**：多数页面原本返回 Fragment，为挂页面根钩子加了一层 `.page-root` 包装；`globals.css` 同步补 4 行（`.page-root > .panel` 间距与既有 `.content-area > .panel` 对齐），确保**视觉零变化**。

### 4.2 S11 前后端路由差集（`apps/api/test/unit/frontend-route-contract.test.cjs`）

静态比对 352 条后端路由 vs 199 个前端调用点，采用**静态段前缀**匹配（前端大量用模板字符串拼 query，严格全等会误报）。

**结果：15 个初判"未匹配"全部是解析器把 query 拼接当成了路径段，修正归一化后 `UNMATCHED = 0`。**
→ 回答了 recon 的 U8：**前端不存在调用不存在端点的情况，前后端路径契约是一致的**。

含**反空虚守卫**：断言解析到的路由数 ≥300、调用点 ≥150，并反向自检匹配器确实会拒绝 `/api/v1/no-such-module/no-such-route` —— 防止解析器失效后"0 条不匹配所以通过"。

### 4.3 S12 契约护栏（`apps/api/test/http/contract-guardrails.test.cjs`）

断言值全部来自**对运行中 API 的实测**（先探针观察，再固化），不凭文档猜测。

| 用例 | 性质 | 实测结论 |
| --- | --- | --- |
| envelope 成功形状 | 正确契约 | `{data, meta}`，列表 `data` 是数组 |
| 未知路由 / 方法不匹配 | 正确契约 | **都是 404，后端没有 405**；message 为英文 `Cannot GET …` |
| 匿名请求 | 正确契约 | 401 `UNAUTHENTICATED` |
| **D2** `meta.request_id` | **已知缺陷** | 不发送请求头时 `meta` 为 `{}`（无 `request_id`）；**只有客户端自带 `x-request-id` 请求头时才会出现**。响应头 `x-request-id` 始终存在且为 UUID |
| **D9** 未知 query 参数 | **已知缺陷** | DTO 端点 → 400 `whitelistValidation`；字面量型 query 端点（`/production/employee-reports`）→ **200 静默忽略** |
| **D10** 嵌套校验 details | **已知缺陷** | 顶层未知字段有可定位 details；**嵌套数组校验失败 details 为 `[]`** |
| **D7** 报表 `meta.total` | **已知缺陷** | `inventory` / `procurement-payables` / `production-qc` / `payroll` 四者的 `total` **等于本页行数**；`orders` 为真实总数（对照） |
| **D8** `sort` 参数 | **已知缺陷** | `?sort=name` 与 `?sort=-name` 返回**完全相同的顺序**（全局声明、无人实现） |
| 分页边界 | 正确契约 | `page_size=200` 通过；`201` / `0` / `abc` / `page=0` 均为 400 且带字段级 details |

缺陷用例统一以 `KNOWN_CONTRACT_DEFECT` 前缀命名，并在断言消息中写明"此处变红说明缺陷已修复，请同步更新本文件与 recon 记录"——把"修复"变成显式信号而非静默变化。

**顺带修掉一个自身缺陷**：`apiClient.get(path)` 未转发第二个参数，导致 `client.get(path, { headers })` 静默丢弃请求头 —— 是 D2 用例把它照出来的（否则该用例会因"没发请求头"而误通过）。

---

## 5. E2E 现状：3 条 spec 写在**已被替换的 UI** 上（重要发现）

本次跑通完整 E2E 后取得硬数据：

| spec | 结果 | 根因 |
| --- | --- | --- |
| `authentication.spec.mjs` | ✅ 2/2 通过 | — |
| `production-daily-report.spec.mjs` | ❌ | 等待 heading「生产日报与告警」，该文案在 `apps/web` **完全不存在** |
| `production-order.spec.mjs` | ❌ | `getByLabel("地点名称")` 超时；`/production` 页**没有**「新增生产地点」「新增工序」按钮（已迁到 `/production/locations` 与 `/production/operations`） |
| `raw-material-movement.spec.mjs` | ❌ | beforeAll 抛 `PrismaClientValidationError`（已修，见下）；进入浏览器后卡在 `select[name="production_order_id"]` |

**已核实**：`保存工序日报` / `保存员工日报` / `查看服务端累计` / `生产日报与告警` / `新增生产地点` / `新增工序` / `name="employee_id"` / `name="wage_mode"` / `duration_minutes` 在 `apps/web` 中**全部零命中**（逐项 grep 验证）。

**这推翻了项目自述的定性**。`docs/announcement/current-development-assessment.md` 把这个 P0 阻塞描述为"测试通过标题筛选 `form` 导致定位超时"，并建议"加 `data-testid`、改用稳定 test id"。但真实原因是**页面被迁移重写**：目标控件与文案已经不存在，加 testid 不可能让它变绿 —— **这 3 条 spec 需要按当前 UI 重写**，属 P5（"E2E 精测"）范围，不在 W2。

**已修复的部分**：`raw-material-movement.spec.mjs` 的夹具遗漏了 `BomItem.materialName`（现已必填），使 beforeAll 直接崩溃 —— 该 spec 此前**连浏览器都没打开过**。补上后已能进入真实浏览器流程，剩余阻塞与另两条同类（UI 漂移）。

---

## 6. 下一步

W2 完成后，`docs/test/01-test-master-plan.md` §5.1 剩余：**W3–W5**（P1 后端单元 / P2 HTTP 契约 / P4 前端大规模扇出）、**W6–W7**（P3 集成并发 / P5 E2E）、**W8** 收敛。

**建议优先级调整**：把 **P5 的 3 条 E2E spec 重写**提到最前。理由：
1. 它们是 CI `chain` 门禁**唯一的红项**，其余全绿；
2. 它们对着的 UI 已经不存在，因此**当前没有任何浏览器级回归保护**——这是风险最高的空白；
3. W2 已把共享原语的 testid 钩子铺好，重写成本比之前低。
