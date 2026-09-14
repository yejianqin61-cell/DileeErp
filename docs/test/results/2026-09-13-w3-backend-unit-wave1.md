# W3 第一波执行结果（后端单元测试批量补齐）

- 提交基线：`c916059`（工作区改动未提交）
- 执行日期：2026-09-13
- 范围：`docs/test/01-test-master-plan.md` §5.1 **W3（P1 后端单元）**，第一波 12 个目标模块
- 方式：12 个 agent 并行编写，每人一个模块，各自跑通

---

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 新增测试文件 | **12 个**（全部落在 `apps/api/test/unit/`） |
| 新增用例 | **370**（后端单元 474 → **844**） |
| 新增断言 | **1,252**（3.4 断言/用例） |
| 反向用例（`assert.rejects`） | **82** |
| 生产代码改动 | **0**（`git status apps/api/src` 为空，已核验） |
| 实测 | `node --test apps/api/test/**` → **844 pass / 0 fail**，`npm run typecheck` exit 0 |

**过程中发现 11 项新缺陷**，其中 1 项是 **P1（静默产出错误数据）**，见 §3。

---

## 2. 逐文件清单

| 测试文件 | 用例 | 断言 | 反向 | 覆盖要点 |
| --- | ---: | ---: | ---: | --- |
| `procurement-master-data-service` | 50 | 156 | 10 | 单位/物料/供应商 CRUD、停用、软删**引用保护**（行锁 + 四张引用表）、恢复、P2002 分流 |
| `finished-goods-inventory-service` | 46 | 189 | 24 | 成品入库/不良品创建、过账、冲销、库存事实；**过账校验排除本单自己**、冲销备注追写 |
| `customers-service` | 42 | 170 | 3 | 客户 CRUD、联系人默认互斥、自动编码 P2002 重试、软删 |
| `dictionaries-service` | 34 | 105 | 13 | 字典类型/项 CRUD、软删、停用项过滤、跨类型同 key |
| `validate-environment` | 32 | 50 | 0¹ | PORT 边界、生产环境 URL 必填、URL 格式；含隐藏强转分支 |
| `reports-service` | 28 | 66 | 3 | 5 个报表路由、分页、CSV 转义、导出上限 |
| `alerts-service` | 27 | 109 | 4 | 三源汇总、去重、处理状态覆盖、分页 |
| `production-daily-alerts-service` | 26 | 86 | 7 | 确认/异常处理、recovered 拒绝、审计载荷 |
| `forms-service` | 24 | 77 | 8 | 表单定义创建/发布/版本、field_key 校验先于写库 |
| `state-machine-service` | 24 | 106 | 4 | 状态机初始化/流转、行锁顺序、非法流转 |
| `prisma-error` | 23 | 88 | 6 | P2002 识别与列名匹配、**物料组合索引不误判为 material_code** |
| `request-log-middleware` | 14 | 50 | 0¹ | 放行、日志字段白名单、耗时、脱敏 |
| **合计** | **370** | **1,252** | **82** | |

¹ 这两个文件用 `assert.throws`（validate-environment 另有自建 `expectRejected`，同时断言"未返回值、未修改入参"）而非 `assert.rejects`，已逐一核验**确有反向覆盖**。

**质量抽检**：`dictionaries-service` 的作者额外做了 4 组**变异自检**（把 `includeInactive`、失败不写入、软删改硬删、falsy 边界分别改坏），确认对应用例会**正确失败** —— 即断言不是恒真。

---

## 3. 新发现的缺陷（11 项，均未修改代码）

### P1：静默产出错误数据

**报表 CSV 导出超过 200 行时被静默截断，且导出上限错误不可达。**

| 项 | 内容 |
| --- | --- |
| 复现 | `ReportsService.export()` 以 `page_size: 5000` 调 `query()`，但 `take()` 把 `page_size` 夹到 **200** ⇒ `findMany` 最多 200 行 |
| 期望 | 导出全部命中行，或在超过 5000 行时返回 422 `EXPORT_LIMIT_EXCEEDED` |
| 实际 | 返回 **最多 200 行**；`result.data.length >= 5000` **永不成立**，`EXPORT_LIMIT_EXCEEDED` 是死代码 |
| 证据 | `apps/api/src/modules/reports/reports.service.ts:25`（`take()` 夹取）vs `:16`（`>= 5000` 判断）；单元用例 `reports.export_silently_truncates_to_200_rows` 实测导出 **200 行数据 + 1 行表头**、无任何提示 |
| 影响 | 财务/报表场景下用户拿到**不完整且无提示**的 CSV（例如 900 条应付只导出 200 条），属数据可信度问题。当前测试库仅 9 条销售单，**无法端到端复现**，但代码事实确定 |
| 建议修法 | `take()` 区分导出场景（导出用独立的 5000 上限），或让 `export()` 走不受 200 夹取的查询路径 |

### P2：审计与可追溯性缺口

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | 生产日报告警 `confirm()` 与 `resolveMergeAnomaly()` 各写**两条**同 action 审计行（事务内一次 + 事务外一次） | `production-daily-alerts.service.ts:28,31` 与 `:48,51`；用例 `confirm_writes_the_same_action_twice_into_audit_events` |
| 2 | 主数据**停用/启用无审计记录** | `procurement-master-data.service.ts:21`(`setUnitActive`)、`:44`(`setMaterialActive`) 等同型三处 |
| 3 | `GET /alerts?status=pending` 会**泄漏已 resolved 的告警** | `alerts.service.ts:18` 用 `query.status` 预过滤 `alert_handling`，导致已处理告警被当作 `pending` 返回 |
| 3b | `handle()` 不回写源表状态（已知，W2 已从前端侧修复联动） | `alerts.service.ts:21` |

### P3：一致性与健壮性

| # | 缺陷 | 证据 |
| --- | --- | --- |
| 1 | 字典项软删后同一 key **永久不可复用**（再建必 409） | `dictionary_items` 唯一键含软删行；用例已固化 |
| 2 | 表单定义软删后**版本号复用** → 撞 `@@unique([formKey, version])` 抛原始 P2002 | `forms.service.ts` 取 latest 时带 `deletedAt: null` |
| 3 | `prisma-error` 的空列名退化为**万能匹配**（`includes("")` 恒真） | `prisma-error.ts:19` |
| 4 | `prisma-error` 列名为 `undefined`/`null` 时抛 `TypeError`，在 catch 里会**掩盖原始 Prisma 错误** | 同上（当前调用方不可达） |
| 5 | 请求日志把**查询串里的 password/token 明文**写入 stdout | `request-log.middleware.ts:7` 用 `request.originalUrl` |
| 6 | 中断的请求完全没有日志（可观测性缺口） | `request-log.middleware.ts` 仅监听 `finish` |
| 7 | 客户更新时不 trim `customer_code`（与 create 不一致） | `customers.service.ts` |
| 8 | `DATABASE_URL` 只校验"能否被 `new URL()` 解析"，不限 scheme/host，`localhost:5432`、`file:///...` 都能通过生产校验 | `validate-environment.ts:6` |
| 9 | `StateMachineService` 确认**疑似死代码**（与 recon 判断一致） | 仅被 `app.module.ts` 注册，无业务调用 |

---

## 4. 下一步

W3 第一波完成（12/12）。按 `01-test-master-plan.md` §5.1 继续：

- **W3 第二波**：剩余后端单元目标 —— `raw-material-movements`(462)、`material-slip-export`(494)、`production-master-data`(441)、`outsource-logistics`(439)、`purchase-order-export`(358)、`employee-daily-reports`(356)、`raw-material-inbounds`(343)、`production-orders`(329)、`finished-goods-qc`(317)、`operation-daily-reports`(254)、`finished-goods-inbound-notices`(242)、`production-payroll-export`(242) 等（含把 3 个已有的薄文件加深）
- **W4**：P2 HTTP 契约（37 控制器 + 5 横切）
- **W5**：P4 前端（58 文件，含把 12 个源码正则断言文件改造为行为测试）

**建议先修 P1 导出截断**：它是本轮唯一"静默产出错误数据"的缺陷，修复面很小（`take()` 区分导出上限），但不修则报表导出对业务不可信。
