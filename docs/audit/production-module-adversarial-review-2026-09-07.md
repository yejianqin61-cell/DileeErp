# 生产模块对抗审查报告（Reviewer vs implement-agent）

- 审查日期：2026-09-07
- 审查基线：git HEAD `f6adda6`（`feat: support inline correction of employee daily reports`），并包含当前**工作区未提交改动**（`apps/web/components/production/daily-reports-panel.tsx` 有未提交修改）
- 审查方式：逐行阅读生产模块后端 13 组 controller/service/domain、平台状态机/权限/审计/库存服务、`prisma/schema.prisma` 生产相关 model，以及生产相关全部 Web 页面/面板与 `lib/api-client`；对照设计文档 `docs/design/production-module-design.md` 与各链路实现设计
- 严重级定义：P0 资金/库存/越权/数据丢失；P1 不变量破坏/并发窗口/契约破裂/敏感数据越权；P2 健壮性/审计/口径/性能

## 0. 总体结论

生产模块后端整体实现质量明显高于“对抗审查”的默认预期：状态跃迁表、乐观锁（`expected_version`）、`FOR UPDATE` 行锁 + `pg_advisory_xact_lock` + Serializable 隔离过账、幂等键、审计事件、逻辑删除与派生量重算等机制都已落地并有单元/集成测试。但对抗审查（主审 + 5 路交叉子审查 A/B/C/D/E，本报告 §6 为合并清单）最终确认：**主审 P1 级 7 项、交叉子审查新增 P1 级约 10 项（去重后核心 P1 约 13 项）**，其余为 P2 级、口径问题与需产品确认的角色/权限疑点。最值得优先处理的是：**仓库领料整链键名不匹配与三个外加工交接按钮 100% 400（前后端契约断裂，E1/E2）**、**外加工签收并发双花与 QC 更正绕过送检上限（资金/库存，C1/C2）**、**生产角色可导出全员薪资（权限）**、**状态跃迁/日报写入的并发窗口（事务）**、**超单/差异告警重算一致性缺口（僵尸 pending 卡死订单）**、**完工/进度对外加工直发口径矛盾**，以及**工作区里被改坏的生产日报面板（未提交、功能回退）**。

---

## 1. P1 缺陷

### P1-1 薪资/员工明细导出与列表只有 `production` 模块权限即可访问（横向越权读薪资）
- 位置：`apps/api/src/modules/production/production-payroll-export.controller.ts:14-20`（类级 `@RequireModules("production")`，两个 xlsx 导出仅此校验）；`production-payroll-export.service.ts:26-40`（导出列含 工号、姓名、部门、单价、总薪酬）；`employee-daily-reports.controller.ts:27`（`GET /production/payroll-sources` 同仅为 production）
- 对照：员工名单 xlsx 导出 `/production/employees/export.xlsx` 是 `@RequireAdministrator()`（`production-master-data.controller.ts:42`），口径明显更严。
- 缺陷说明：按设计文档，凡持有 `production` 模块权限的操作员（物控、采购、销售等）即可不附带任何角色筛选导出**全公司车间员工的日薪/计件单价/参考薪资**，或拉取 `payroll-sources` 聚合薪资；这些数据在薪资链路里本属 HR/财务域的敏感信息。属敏感数据越权读取。
- 修复建议：至少改为 `@RequireAnyModules("hr","finance")` 并在方法级叠加管理员校验，与员工导出一致；或明确引入“薪资查看”独立权限位；同时给导出事件保留审计（现有审计保留，需把 actor 的角色也纳入授权判定）。

### P1-2 生产单状态跃迁 check-then-update 未加锁，并发转换可穿透校验
- 位置：`apps/api/src/modules/production/production-orders.service.ts:64`（`transition()`）；同类问题在 `apps/api/src/platform/state-machine/state-machine.service.ts:19-30`（`transition()` 先读 `stateRecord` 校验 allowed，再开 `$transaction` 更新，事务内不再校验/加锁）。
- 缺陷说明：`transition()` 先 `get(id)`（事务外读状态），事务内用普通 `findFirst` 复查 `locked.status !== current.status` 后直接 `update`。两个并发请求（如同一 `in_progress` 单同时转 `completed` 与 `paused`，或重复点击“完工”）都能读到同一旧状态、都能通过复查，最后写入者覆盖前者的目标状态；两条审计均会记录，`assertCompletionReady`（含未确认告警/未达标工序拦截）在其中一个分支被真正旁路。StateMachineService 的 read-check-write 亦为同型 TOCTOU。
- 修复建议：事务内先 `SELECT id FROM production_orders WHERE id=... FOR UPDATE`（或 `update ... where id and status=旧值` 并检查 affected=1）后再重读重验；`state-machine.service` 的 `transition` 也应在事务内对 `stateRecord` 加行锁并重读 `currentStateId`。

### P1-3 日报“状态校验在事务外、事务内不回读生产单状态”的并发窗口
- 位置：`apps/api/src/modules/production/employee-daily-reports.service.ts`（`create` 27→29 行先 `refs()` 后开事务；事务内 30-34 只锁**工序行**，不回读生产单状态；`refs` 140-150 的订单状态校验在事务外；`createBatch`/`update`/`remove` 同型）；`operation-daily-reports.service.ts`（`create` 40→41、`update` 63→66、`remove` 84→85 同样先查后锁且只锁工序/日报行）。
- 缺陷说明：若“完工/暂停/关闭/取消工序”与“新建或更正日报”并发，日报侧在事务外看到 `in_progress`，事务内只锁工序行，生产单状态在其后被并发改为 `completed`/`paused`/`closed` 也能提交成功——新建日报会落在已完工/已暂停单上，绕过 3e545ea“完工后禁止新增”与设计 §7.3 的状态约束（同样可绕过“已取消工序不可新增日报”）。
- 修复建议：把 `refs()`（或至少订单状态与工序状态校验）移入事务内，并在事务内先对 `production_orders` 行 `FOR UPDATE` 后重验；`update/remove` 亦在锁内复核。

### P1-4 工序日报 update 把日期改成已存在行日期时不合并 → 同日双行、累计量重复
- 位置：`apps/api/src/modules/production/operation-daily-reports.service.ts:59-78`（`update()` 直接把 `reportDate` 改成新值并整行替换数量，不检查“目标日期是否已有同工序日报”也不合并）；汇总侧 `recomputeOverOrder` 134-157 与进度读模型 `production-progress.service.ts:80/88-89` 都是对同工序所有行求和。
- 缺陷说明：某工序 8/1 已有日报行 A（100 件），再补一行 8/1 日报并 merge（`create` 会累加到 A）；随后对 A 做更正把日期挪到 8/1 场景虽罕见，但更常见路径是：A 在 8/1（100），新建 8/2（50），再把 8/2 行的日期改回 8/1 —— 此时不合并、生成同日两行，累计量变成 150+50=200 虚增，超单告警与完工进度全部错乱。员工日报侧对此有拦截（`employee-daily-reports.service.ts:98-103` `DAILY_REPORT_DUPLICATE_TARGET`），工序日报侧缺失。
- 修复建议：与 `create()` 的“当日合并”语义保持一致——目标日期已有行则累加合并（并校验与告警一致），或显式抛 `DAILY_REPORT_DUPLICATE_TARGET` 让操作员先合并/更正原行。

### P1-5 工序日报变更从不重算 daily_discrepancy 差异告警（口径回写缺失）
- 位置：`apps/api/src/modules/production/operation-daily-reports.service.ts`（`create/update/remove` 只调用 `recomputeOverOrder`，见 51/72/91）；跨口径重算 `recomputeDiscrepancy` 只存在于员工日报服务（`employee-daily-reports.service.ts:207-217`）且只在员工日报增删改时被调用。
- 缺陷说明：当“工序日报量 vs 员工日报件数”出现差异生成了 `daily_discrepancy`（pending/confirmed）告警后，若操作员通过**更正/补录工序日报**使两边一致，系统不会把该告警自动置为“已恢复”，数值也不会刷新——与设计 §7.3「任一日报变更时更新同一条告警，重新相等时自动恢复」不符，告警中心会长期残留假阳性。
- 修复建议：工序日报 create/update/delete 在同一事务内也调用一次跨口径 reconciliation（把 `recomputeDiscrepancy` 提取为共享方法，按受影响的 工序+日期 重算），或在 alert 查询/展示时以实时聚合为准。

### P1-6 工作区未提交改动使生产日报面板功能回退（工序日报入口丢失、更正原因被硬编码、死代码）
- 位置：`apps/web/components/production/daily-reports-panel.tsx`（工作区 vs HEAD `f6adda6` 有未提交 diff）
- 缺陷说明（均为 diff 实测）：
  1. `save()` 中原「本次新增工序完成量」输入与 `POST /production/operation-reports` 联动提交被移除（`git diff`：删掉 operationQuantity 校验与提交，只剩员工日报 batch），D5“工序完成量+员工日报同录”的入口从此消失；而工序累计/超单告警完全依赖工序日报。
  2. 内联更正把「更正原因必填」校验替换成 `if (false) { … return; }` 死代码，并把提交的 `reason` 硬编码为 `"查改一体修改"`（`inlineReason` 初始化即固定值，输入框也一并被移除）——设计 §8.2「每次修改必须保留备注/原因并审计」在 UI 层被破坏。
  3. 汇总口径被改乱：`completedQuantity` 从“选中日期工序日报量”改成“全周期工序日报总量或全量员工件数任选其一”，超单判断可能把不同日期的累计与计划量直接比较，显示误导。
  4. 代码里残留大量怪异缩进与空行，疑似半成品/合并不当。
- 修复建议：与 `f6adda6` 对 diff 决定取舍——恢复工序日报联动提交与「更正原因」输入；删除死代码与硬编码 reason；恢复按“选中日期”的汇总口径；随后提交并补回归（`production-daily-report.spec.mjs` 场景需可闭环）。

### P1-7（权限模型待确认）生产主数据写接口全部要求管理员，而共享主数据写接口只要求所属模块权限
- 位置：生产侧 `production-master-data.controller.ts:31-64`（工序池/地点/员工/部门/岗位/计件价目的增删改全部 `@RequireAdministrator()`）；对照采购侧 `procurement-master-data.controller.ts:15-24`（`/units` 增删改仅 `@RequireModules("procurement")`，无管理员门槛）；前端 `app/production/page.tsx`、`master-data-pool-page.tsx` 对所有 production 用户展示「新建/编辑/停用/删除」按钮。
- 缺陷说明：按设计文档工序池由“物控”维护，但代码把所有主数据写锁死为 administrator；非管理员的 production/物控用户点按钮即 403，UI 无权限态处理；而 `units`/`materials`/`suppliers` 等全局主数据反而任何 procurement 角色可写、无管理员限制——两侧严格度不一致。另：成品质检全部动作挂在 `warehouse` 模块键下（`finished-goods-qc.controller.ts:21-32`），外加工批次创建/直发/签收挂在 `procurement`（`outsource-logistics.controller.ts:30-34`），回厂/直装柜挂在 `warehouse`（35-41），但这些工作流都在**生产模块页面**里操作——模块键归属与 UI 展示域不一致，非多模块授权的用户会直接 403。
- 修复建议：与产品确认角色矩阵后统一——把工序池/计件价目等按设计交给“物控”角色（新增细粒度权限或 `production.manage`），其他管理员操作在 UI 按权限隐藏；外加工/QC 按钮按调用方模块键（procurement/warehouse）显隐，或在路由上改成 `RequireAnyModules` 并在文档固化模块边界。

---

## 2. P2 缺陷（健壮性/口径/审计/性能）

- P2-1 多数列表无分页且无上限：`production/orders`、`production/employee-reports`、`production/operation-reports`、`production/material-movements`、`production/outsource-logistics-batches*`、`production/locations?include_deleted=true` 等一次性全量返回（如 `employee-daily-reports.service.ts:15-17`、`production-orders.service.ts:13`），而 Web `apiGet` 固定 10s 超时（`apps/web/lib/api-client.ts:9`）。数据增长后生产页/日报面板将超时。修复：列表统一分页或至少服务端过滤 + `take` 上限。
- P2-2 生产页“新建生产单”只能看到前 20 张销售单：生产页 `GET /sales-orders` 未带分页参数，`sales-orders.service.ts:14` 默认 `pageSize=20`（且只取前 20 的已确认带 BOM 单），超过 20 张单后无法在 UI 开生产单。修复：生产页改用 `status=confirmed&page_size` 放大的专用源或提供“待生产订单”端点。
- P2-3 员工日报“同日合并”语义下 `unitPrice` 快照被末次录入价覆盖（`employee-daily-reports.service.ts:39/77` 更新已存在行时 `unitPrice: values.unitPrice` 而金额是逐笔累加）——同一行明细的单价快照与成分不一致，导出“单价”列会误导；且录入/改价没有强制写 `priceOverrideReason`（schema 有该列，`values()` 未使用），设计 §3.6 要求手改单价必填原因。修复：合并行保存每笔单价（或加权均价），并为手填单价补原因字段链路（前端已要单价但未要原因）。
- P2-4 成品质检 `submit()`/`cancel()` 对 submission 与 `outsourceReturnTransfer.finishedGoodsQcStatus` 的更新不在同一事务（`finished-goods-qc.service.ts:77-94` 两次独立 `update`）；`updateSubmission`（62-75）事务内无行锁与版本复查（外层版本检查与写之间可被并发提交穿透）。建议整链单事务 + 事务内重验 version/status。
- P2-5 QC 汇总读模型口径风险：`inHouseAvailable()`（`finished-goods-qc.service.ts:191-195`）以 min(计划量,各工序累计量) 作可送检量，未考虑与成品的计量单位/口径差异（多工序不同单位时按数值 min 不安全）；送检与判定已做总量闸门（锁源行 + 可送检量校验 51-54），但建议把该口径纳入单据并二次确认“厂内完工量 = 瓶颈工序量”的业务定义。
- P2-6 外加工金额用 JS number 运算后 `toFixed(4)`（`outsource-logistics.service.ts:79` amount=quantity*unitPrice；可退/可收余量 67-69、111-112 同样 float 累减），与项目其余十进制（Decimal）处理不一致，极端数量/多次短收叠加会出现 4 位小数后的漂移。建议统一 `Prisma.Decimal`。
- P2-7 事务锁顺序未约定导致潜在死锁：`postIssue` 按明细顺序对每物料加 advisory lock（`raw-material-movements.service.ts:133`），并发多物料单互以相反顺序加锁可能 `40P01 deadlock_detected`，该错误码未像 P2034 那样被翻译成友好 409（146-152 只处理 P2034）。建议物料锁排序后再加锁并统一错误映射。
- P2-8 员工列表读接口把整行员工（含 `userId` 账号绑定、离职/停用信息）直接返回给仅持有 production 权限的调用方（`production-master-data.service.ts:28` 全字段返回；前端日报面板与 HR 页面共用）。请按字段最小化收敛响应（只留工号/姓名/在职状态等）。
- P2-9 数量/单价未设上限：Decimal(18,4) 溢出（如 1e13 件 × 单价）会以 PostgreSQL 22003 numeric overflow 形式冒泡成 500（filter 只翻译 P2002）。建议在 DTO/values() 层加范围上限与友好错误。
- P2-10 仓库/生产/外加工多处 `Number(...)` 直接比较字符串数量（`outsource-logistics.service.ts:32/45/56/67-69/92/111-112`；`production-orders.service.ts:19/25/28/48`），若 DB 值来自 4 位小数字符串会有字典序/精度陷阱；应统一 `Prisma.Decimal` 比较。
- P2-11（口径）`production-progress`/`operation-daily-reports` 的超单告警以“最新日报日期”定位告警行（`operation-daily-reports.service.ts:149` unique 键含 reportDate），若后续把较早日期日报删除/回退会恢复告警但“持续超单告警”唯一行语义与日期绑定相矛盾，建议告警按工序+type 维护最新状态而不绑 reportDate 键（与设计 §7.3 “同一生产单同一工序同类型只保留一条持续超单告警”核对）。
- P2-12 附件/CSV 导出防注入：生产导出为 XLSX（`xlsx` 写字符串单元格），CSV 导出集中在 reports 模块；建议统一对以 `= + - @` 开头字段做转义/加前缀，防 Excel 公式注入（员工姓名/备注等由外部导入内容可携带）。

---

## 3. 待产品/实现确认（疑点）

- Q-1 设计 §3.6/§7.3 允许“已完成”补录日报，但 3e545ea 后 `create` 的 `refs()` 只放行 `in_progress`（`employee/operation` 两处 148/129 行）——已完成的补录入口被关闭；同时 `completed → in_progress` 可无门槛重开（`production-orders.service.ts:64` allowed.completed 含 in_progress），而 `closed` 无任何可恢复流转（allowed 表不含 closed）与设计“已关闭需恢复为已完成再调整”不符。请确认产品口径：完工后是否允许补录？关闭单是否需要“恢复/反关闭”操作？
- Q-2 “已取消工序”上更正/删除日报被放行（`employee-daily-reports.service.ts:145` 仅 `!correction` 检查工序状态；b9d848a 后 employee 更正也不再检查工序状态），而设计 §3.4 说已取消工序“不再允许新增或修改日报（历史保留）”。修改/删除是否也应禁止？需与 implement-agent 的意图核对（b9d848a 有意放行更正以支持纠错，但无设计背书）。
- Q-3 生产-薪资边界：`syncPayrollSource` 对非 workshop 员工直接软删既有 payroll source 并将已确认/已付台账置为 `expired`（`employee-daily-reports.service.ts:166-195`）——把员工类型从 workshop 改走会回填重算历史薪资，需确认该幂等破坏是否符合 HR 边界规则（737ee00 的意图）。
- Q-4 `employee-daily-reports` 按 (员工+工序+日期+计薪方式) 把多笔日报合并为一行并累加，schema 无唯一约束仅靠锁 + 事务内查；若未来并发/不同实例直连（多实例部署）或数据库隔离降级，需考虑迁移到唯一索引 + upsert 幂等（现为 `FOR UPDATE` 串行化，单实例内成立）。
- Q-5 外加工/QC 与“成品直装柜”的 receivable 来源与库存事实目前分散在 warehouse 域，生产模块的 `buildProductionOrder` 读取它们；请复核 d7 读模型对“部分签收/短收/冲销后重算”与 QC 判定入库、不良品处理的联动是否纳入告警口径（`qc_summary` 已统计但 blockers 未含 QC 异常）。

---

## 4. 建议修复优先级

1. 立即（资金/越权/数据一致）：P1-1 薪资导出权限收紧；P1-4 工序日报改期合并；P1-5 差异告警跨口径重算；P1-2/P1-3 行锁与事务内重验。
2. 本迭代：P1-6 生产日报面板与 `f6adda6` 对齐（先定语义再提交）；P1-7 角色矩阵与按钮显隐；Q-1/Q-2 状态/工序口径确认。
3. 收紧期：P2 全表分页、Decimal 统一、外加工金额/锁顺序/错误映射、员工响应裁剪、QC submit/cancel 事务化。
4. 仓库卫生：清理工作区未提交改动与根目录多个 `.tar.gz`/`dilee-images.tar` 构建产物，避免把大文件带入版本库与发布包。

## 5. 审查锚点附录（已逐行阅读）

- 后端：`modules/production/*.controller.ts`（12 个）+ `*.service.ts`（除 employee 导入导出细节外全读）、`production-progress.domain.ts`、`platform/state-machine/*`、`platform/inventory/inventory.service.ts`、`platform/authorization/*`、`platform/http/*`、`platform/audit/current-user.decorator.ts`、`prisma/schema.prisma` 生产相关 model（1422-1858 行及库存/外加工/QC model 全表）。
- 前端：`app/production/*`、`components/production/*`、`components/warehouse/finished-goods-qc-panel.tsx`、`app/warehouse/page.tsx`（领料/退/报废链路）、`lib/api-client.ts`；生产页联动的 `/sales-orders`、`/units`、`/inventory/raw-material-balances`、`/attachments` 契约已核对。
- 版本对比：`git log` 生产模块最近 ~60 条提交与关键“加固”提交 diff（b9d848a、3e545ea、f6adda6、8881796、7cf6956、0fadfe6、f38ca03 等）均已人工复核其对并发/状态的处理是否完备。
- 本报告所有代码行号以审查时的 HEAD/工作区内容为准；未逐行核实的个别点已在文中标注“待确认”。

---

## 6. 交叉子审查合并清单（A 生产单/进度、B 日报/告警/薪资、C 外加工/QC/领料、D 主数据、E 前后端契约）

> 五路子审查均基于逐行阅读并给出文件行号；主审已对其中关键论断逐条回查代码（E1/E2/E3 经 `action-dialog.tsx`、`warehouse/page.tsx`、`outsource-logistics-panel.tsx` 复读确认；C1/C2/C9 对照 `outsource-logistics.service.ts`、`finished-goods-qc.service.ts` 确认；A1/A4/A7 对照 `production-orders.service.ts:60-64`、`production-progress.service.ts:90-103` 确认）。下表为**去重后**结论；与本文 §1/§2 重复者以“= 本文 §x”标注。

### 6.1 新增 P1（并入 §1 后去重编号从 P1-8 起）

| 编号 | 严重级 | 位置 | 问题与触发 | 修复要点 |
|---|---|---|---|---|
| P1-8（E1） | P1 | `web/app/warehouse/page.tsx` L28/47/50-51 vs `raw-material-movements.controller.ts` L10、`service.ts` L291 | 领料明细前端用 camelCase `materialId`，后端只认 snake `material_id`（同一页退料/报废用 `source_issue_line_id` 是通的）→ **新建/编辑领料、影响预览整条链路必 422**，预览被前端 catch 静默置空。 | 前端发送前映射 `{material_id, quantity, remark}` 并同步类型；或后端补 `materialId` 兼容（推荐前者）。 |
| P1-9（E2） | P1 | `web/components/production/outsource-logistics-panel.tsx` L29 + `ui/action-dialog.tsx` L20/26 | ActionDialog 把**所有字段（含未填的空串）**整体提交；`transfer()` 三个动作（余料回厂/成品回厂/直装柜）body 恒多出 DTO 之外的键（`product_description`/`logistics_batch_id`/`material_id`/`shipment_date`/`logistics_reference` 等）→ 全局 `forbidNonWhitelisted` 使三个交接按钮 **100% 400**。 | 按路径构造仅含 DTO 允许键的显式 payload；空字段置 undefined 再提交。 |
| P1-10（C1） | P1 | `outsource-logistics.service.ts` L63-84 | 外加工签收剩余量校验在事务外（L67-69 用快照 `receipts`），事务体（L75-81）无批次行锁/无事务内重算/无 Serializable → 并发两份各 100 的签收可同时对 100 的直发量通过，生成两份各 100 的 `outsourcePayableSource`，**应付翻倍**；DB 无总量约束兜底。 | 事务内先 `FOR UPDATE` 批次行→重读 receipts 重算 remaining→条件更新；P2034→409。 |
| P1-11（C2+C9） | P1 | `finished-goods-qc.service.ts` L139-165 | `correctQc` 对 replacement 记录**不校验 ≤ submission.submittedQuantity**（新建路径 L108-111 有，更正路径漏）→ 可把合格数抬过送检量/来源量，再经入库形成虚增成品库存与应收；同时 L159 无条件把 submission 置 `qc_completed`，部分检验被更正后剩余送检量永久不可录。 | 更正路径锁 submission 行、重算“其它 active 记录+replacement”合计 ≤ submittedQuantity，并复用 `sourceAvailable`；更正后按已检覆盖度推导状态。 |
| P1-12（C3） | P1（涉口径） | `outsource-logistics.service.ts` L52-61/133-150/271-277；`raw-material-movements.service.ts` L271-276 | 外协直发不产生任何库存事实、`requireInHouseOrder` 又禁止外协单走领料扣减；余料回厂只登记不产生回补事实、`submitReturnForQc` 后停在 `pending_qc` 无后续处理，且回厂数量无“≤ 该批已直发量”上限。若同一 PO 物料已先入库厂内余额再直发，则账实漂移。 | 与产品确认口径：直发即扣（或强走外协领料过账）、回厂经确认后 +Delta 入账并串接单据；回厂量按批次设上限；或显式声明“不记账”并禁止与余额口径混用。 |
| P1-13（A3+A4） | P1 | `production-orders.service.ts` L60-62；`production-progress.service.ts` L91-92/102 | 外加工完工门槛只统计 `finished_goods_return`，走“直装柜直发”的单永远无法 `completed`/`closed`（422）；而 progress 又把直发当完工来源且以 `planned_quantity:"0"` 行参与计算（整批回厂量被标成“超单”），`returns/shipments.length>0` 即判“生产完成”——同一事实两端口径互斥。 | 完工门槛把回厂与直发按来源去重后与 plannedQuantity 比较（需产品确认直发可否独立构成完工凭据）；进度行带正确 planned/口径分组，部分交付不得判完成。 |
| P1-14（B3） | P1 | `employee-daily-reports.service.ts` L38-39/76-78/90-104/152-164 | 同日同方式合并行在两次不同单价录入时 `unitPrice` 被末次覆盖而金额按各笔累加（如 10@5 + 10@7 → quantity=20, price=7, amount=120 ≠ 140）；随后任意 PATCH（哪怕只改备注）用“总量×当前单价”整体重算 → **未变数量也自动多算工资**，薪资来源/台账被刷新。 | 合并点校验单价一致性（不一致则要求走更正流程），update 不得用总量×单价整体重算，保留每笔金额/单价结构（或拆分存储）。 |
| P1-15（B5） | P1 | `employee-daily-reports.service.ts` L171-194 | 生产操作（补录/更正/删除日报，仅需 production 权限）会把 **confirmed/partially_paid/paid 的 HR 工资台账直接置 `expired`**，无原因、无 auditEvent，且不处理已付款分配；生产模块以非财务身份改写跨模块金钱状态。 | 台账失效改为受控动作：paid 一律拒绝自动过期（由财务处理）；其余要求 reason+auditEvent；状态变更全量留痕。 |
| P1-16（B1+B2） | P1 | `operation-daily-reports.service.ts` L140-157、L51/72/91；`employee-daily-reports.service.ts` L207-217 | ① 超单告警按“最新日报日期”做唯一键落点，超单持续多日会**每日插一条**，回落后只恢复最新日那条，其余僵尸 pending → 经 progress L96 把整单永久 `blocked`；② 工序日报增删改从不触发 daily_discrepancy 重算（= 本文 P1-5）。 | 超单告警按 (op, type) 找唯一持续告警、仅更新快照；回落时全量恢复未 recovered 告警；工序日报变更在同一事务触发差异告警重算。 |
| P1-17（B4） | P1 | `operation-daily-reports.service.ts` L37/41-50 | 工序日报 `idempotency_key` 检查在事务外且事务内**无复查**（员工路径 L31-34 有）→ 同键并发双提交都判“不存在”后走“存在即累加”，同一逻辑提交被计 2×Q。 | 锁工序行后、find/merge 前用 idempotencyKey 复查并返回既有记录。 |
| P1-18（A2+A6） | P1 | `production-orders.service.ts` L48/49/69；`operation-daily-reports.service.ts` L41-54/66-97 | ① 工序编辑/取消是无锁“检查-更新”，可与完工并发 → 完工单事后被改结构（取消达标工序/下调 target），DB 无兜底；② 日报“同日合并累加”锁工序行、而“修正/删除”锁日报行，两把锁不同 → 并发下数量事实被吞或写入已软删行。 | 取消/编辑/合并/修正统一走“锁父订单行 + 锁目标行 → 锁内重查状态/数量 → 写”的单事务范式；合并用 CAS/ON CONFLICT。 |

### 6.2 新增 P2/疑点（去重后选录，完整表见各子审查输出）

- P2 契约/前端：E3（主数据池新建工序把空串 `default_unit_id`/`operation_code` 一并提交 → 400/二次创建 409）；E4（production 主页面板编辑/停用走 `apiPost` 而路由为 PATCH，当前为不可达死代码）；E5（= 本文 P2-2 `/sales-orders` 默认 page_size=20 截断生产单候选）；E6（QC 快捷流程用“orderNo+draft”猜测定位新建送检单，可能挂错单，应直接用创建返回值 id）；E7（直装柜行无 `transferNo`，合并列表该列恒空）；E8（日报行内更正遇版本冲突失败后残留旧 expected_version → 死循环 422，需失败即刷新并清 edits）。
- P2 权限/域：D1（采购 `/units` 等共享主数据写无 admin 门槛、`deleteUnit` 引用检查漏 `operationCatalog.defaultUnitId`，软删无 restore、`unit.name` 唯一墓碑）；D2（= 本文 P2-8 + HR 侧需 production 权限才能读自己的员工池，域错配）；D3（计件价目重叠校验读-改竞态，无 DB 排他约束）；A17（生产单 delete/completed/closed 等写仅 production 模块权限，是否需 admin 待产品确认）。
- P2 输入/健壮性：A11/C13/B13（`Number()` 与 `Decimal` 解析不一致：`"abc"`→500、hex 静默、`" 5 "`→500、小数位 >4 被 PG 舍入、超精度 500；统一 `parseDecimal` 帮助函数 + 范围/精度护栏）；C10（`lines[]` 嵌套 DTO 无 `@ValidateNested/@Type` → 行内校验落空，非 UUID/超长 remark 打 500）；C6/C14（外加工数量/金额用 float `Number`/`toFixed(4)`，改 Decimal）；C11（过账风险记录 `line_id` 恒 NULL——previewLines 行 id 未带出——且超领/非 BOM 确认为本人自审）；C5（厂内送检不校验生产单状态，closed 单仍可送检→QC→入库→出库形成应收）；C16（QC 判定/入库/出库同一 warehouse 权限自审闭环）。
- P2 主数据/一致性：D4（PATCH `body: Partial<Dto>` 在 ValidationPipe 下 metatype=Object、校验/白名单失效，master-data service 还裸 spread 直写 Prisma——需用显式 Update DTO；疑点标注需实测一次确认）；D6（员工状态转移无守卫：left→active 不清 leftOn、可绕 leave 接口直写）；D7（主数据删除/恢复无 audit 事件，restore 清 deletedBy 抹痕）；D8（软删墓碑占用无条件唯一键 → “删了建不回来”；Unit 无 restore）；D9（删除 count→soft-delete 非事务，与新引用并发交错）；D10/D11/D12（员工导入逐行错误不落地整批 500/409、无文件类型白名单、日期/“车间/非车间”标签四处分叉）；D13（employee.user_id 无 FK/唯一/存在性校验）；D14（参数错误统一抛 409 语义错位）。
- P2 进度/读模型：A16（进度接口全表拉取 + 每单 7 查询 + 内存分页，无快照读，慢请求/读数矛盾；timeline 无 orderNo 索引）；B12（差异告警被贴到每道工序行且 blocker 不看告警归属/日期）；A7/A8（pending 告警按整单计数且包含已取消工序的历史告警 → 与 progress“取消工序不计入”矛盾、可卡死完工；“已取消工序可修正日报”与设计冻结冲突）；A9（外协单的工艺说明工序被当 in_house 计量行）；A10（seq 槽位代码允许复用、DB 唯一约束不允许）；A12（`bom_version` 死输入、BOM 未过滤 status、快照不含 items）；A13/A14/A15（工序目标调整无 reason/before-after、删父单不管子单、`actual_completed_quantity` 恒 null 死列 + completed 后修正无状态回退机制）。
- P2 审计/口径：B6（离职员工日报无法更正/删除——refs correction 仍强制在职）；B7（历史补录不强制原因）；B8（工序日报 impact-preview 的 after_delete 不含排除本行）；B11（同键合并模型丢失“每次提交”审计粒度）；B14（已取消工序仍可改数量，与设计“冻结”冲突）；B9（= P1-1 导出权限）；B13（时长非整数/超上限 500）；E8 等。
- 疑点区（需产品/运行验证）：计时单价量纲（元/分钟 vs 元/小时，文档矛盾，代码按分钟×单价——若按小时会差 60 倍）；角色/权限 seed 是否给非管理员 production 模块权限（决定 A17/E 疑点 1 是否引爆）；外协直装柜与应收/出库无集成（漏应收？）；同 PO 明细可同时进采购到货应付与外协应付两套来源；Reverse 后 finance payable entry 联动；时区 UTC 今天 vs UTC+8 本地今天（日报“未来日期”误拒）；双击过账不同幂等键二次 422；Partial<Dto> 校验失效需一次真实 PATCH 实测。

---

## 7. 最终修复顺序（按资金/库存/可用性风险）

1. **契约断裂先修（可直接让功能恢复）**：E1 仓库领料键名、E2 外加工三个交接按钮、E3 主数据池空串、E6 QC 创建返回 id 直用、E8 日报更正失败即刷新。
2. **资金/库存一致**：C1 签收并发双花；C2/C9 QC 更正上限与状态推导；P1-1 薪资导出/读取权限收紧；B5 工资台账过期护栏。
3. **不变量与并发**：P1-2/P1-3/P1-17/P1-18（transition、日报写入、工序幂等与合并修正行锁范式）；P1-4 工序日报改期合并；P1-5/P1-16 差异与超单告警重算/僵尸收敛。
4. **跨模块口径（需产品确认后落地）**：P1-13（外协完工/进度口径）、P1-12（外协原料账实）、P1-6 生产日报面板与 `f6adda6` 对齐提交、P1-7/Q 角色矩阵与 admin 边界、Q 系列（完成补录、关闭恢复、已取消工序冻结、单位换算等）。
5. **健壮性收紧**：Decimal 统一（A11/C6/C13/C14）、嵌套 DTO 校验（C10）、分页/上限与进度快照读（A16/E5）、主数据删除恢复审计与唯一墓碑（D7/D8）、员工导入逐行错误（D10-D12）、风险记录 line_id（C11）、错误码语义（D14）等。

---

## 8. 修复执行与独立复审记录（2026-09-07 第二批次）

按 §7 顺序把可实施项拆为 7 个 implement-agent 并行修复（严格文件隔离、各自独立 Conventional Commit），随后 3 个测试适配提交，构建/单测门禁全绿，再由 7 个**独立 review-agent**（R1–R7，只读、不信任实现方自述）逐提交对抗复审。门禁结果：API `typecheck` 0 错、`nest build` exit 0、全量单测 **138/138 通过**（`apps/api/test/*.test.cjs` + `unit/*`，dist 为最新构建）。

### 8.1 提交清单（main，依序）

| commit | 类型 | 内容 | 复审 |
|---|---|---|---|
| 4487af5 | fix(production) | 员工日报薪资联动加固（异价合并 422、台账 confirmed-only 过期+paid 保护+审计、离职可更正、补录原因、整数时长/精度护栏、共享 reconcileDailyDiscrepancy、薪资 xlsx=admin / payroll-sources=hr\|finance） | R2 |
| c438709 | fix(production) | 工序日报/告警（事务内幂等复查、取消工序冻结、改期冲突 422、超单告警 per-op 单条+回落全量恢复、差异告警联动、impact preview 排除自身） | R2 |
| f829956 | fix(production) | 生产单/平台状态机（transition/update/delete 行锁+锁内复检、工序编辑取消锁+reason、序列槽位对齐 DB、BOM 版本+items 快照、外协完工=回厂+直发、actualCompletedQuantity 回填、Decimal 护栏、审计 before/after） | R1 |
| f0b1a58 | fix(production) | 外加工/QC/领料（签收 FOR UPDATE 锁内重算、全写路径条件更新、QC 更正上限+状态推导、厂内送检状态门禁、嵌套 DTO 校验、风险 line_id、advisory 排序、P2002/P2034 映射） | R3 |
| 5ce6c6c | fix(production) | 进度读模型（外协 delivered≥planned 完成判定、按单位归并不再 planned=0 超单误标、差异告警按工序归属、分页下推） | R4 |
| 4edf916 | fix(hr) | 主数据（显式 Update DTO+白名单映射、rate 重叠锁内复核+单价护栏、员工状态转移守卫、delete/restore 事务化+审计、restoreUnit、导入逐行 partial/日期类型归一/userId 校验、错误码 422/409 归位） | R5 |
| b7db2df | fix(web) | 前端契约（领料 snake_case 映射、外加工三动作只发 DTO 键、主数据池空串归一、删死代码、QC 用创建 id、日报面板恢复 HEAD 语义+版本冲突刷新） | R6 |
| 7cd1896/761c9eb/74f9f55 | test(*) | 主数据/采购主数据/员工日报单测随新语义与事务化对齐 | R1/R2/R5 佐证 |

### 8.2 复审判定摘要（FIXED 均未发现需回退项；PARTIAL/NEW-ISSUE 进入后续清单）

- R1（f829956）：TOCTOU/工序锁/槽位/告警排除/BOM 版本/Decimal/审计全部 FIXED；NEW：**op↔order 反向锁序 ABBA 暴露（operation-daily-reports 为唯一逆行方）**、子生产单 create 与父 delete 残留竞态、UpdateProductionOrderDto.unit_id 声明但未落库。
- R2（4487af5+c438709）：共享 reconcile 等价、超单告警收敛、幂等复查、单价/台账/离职更正等 FIXED；NEW：与 R1 相同的 op↔order 锁序问题（必改）、employee 合并溢出/金额积无护栏、xlsx 导出面板无角色态。
- R3（f0b1a58）：签收双花/QC 更正上限/门禁/嵌套校验/风险行号/错误映射全部 FIXED；NEW：outsource **batch create 无锁可越 PO item 总额**（update 已锁）、QC domain 裸 Error→500、listSources 未过滤状态、签收 UI 无 difference_reason。
- R4（5ce6c6c）：与 T1 完工口径一致、A9/B12/字段兼容 FIXED；NEW：外协**异单位来源计入完成判定 + planned=0 行仍显 over_order**（与 assertCompletionReady 同源，需两文件同步修）；total 语义变化与非快照读未注释。
- R5（4edf916）：DTO/锁/状态机/审计/导入 FIXED；NEW：HR 页无“启用/复职”入口致离职日期纠错 409 死胡同、导入 partial 文案不一致、userId 无 DB 唯一（需迁移）、restore 未锁/生产侧无 P2002 兜底。
- R6（b7db2df）：6 项全部 FIXED、web tsc 0 诊断；提醒：清空既有可选键需发 null、QC 草稿即录 QC 仍会被后端状态门槛拦（pre-existing）、直装柜对话框冗余必填项。
- R7（全局）：完工口径三处一致、HTTP 契约 E1–E8 对齐、138/138 全绿；遗留集中为 **UI/角色层未跟进后端收紧（403 裸错/动作缺入口）**、**op↔order 锁序**、**DB 层迁移欠账**，详见 §8.3。

### 8.3 主 Agent 下一步行动清单（R1–R7 合并去重、已排级）

- **P0（资金/越权/链路可用）**
  1. ABBA：把 operation-daily-reports.service `lockOrderAndOperation` 改为 先 production_orders→op→日报行（与 employee/T1 统一），并为日报写事务补 P2034/40P01→409+刷新提示。
  2. UI/角色：全站引入角色源（/auth/roles）并按权限显隐——PayrollExportPanel 仅 admin、主数据写按钮、外加工(procurement)/回厂·直装柜·QC(warehouse)/生产页按钮按角色显隐，页面跨模块读依赖按角色降级。
  3. 前端链路补齐：短收表单补 difference_reason；成品/余料回厂补「提交 QC」、直装柜补「发出」；历史补录补“原因”输入；批次取消/签收冲销/直发冲销/QC 更正入口。
- **P1（迁移/一致性/契约）**
  4. DB 迁移：employee.user_id FK+部分唯一索引；主数据墓碑→部分唯一索引（unit/material/supplier/department/position/location/operation 等，含历史清理与 create/restore 口径）；audit_events (order_no, entity_type) 复合索引；production_daily_alerts “open 告警”部分唯一索引 + 一次性收敛历史重复超单告警；复核外协 finished_goods_return 的 reversed 死过滤。
  5. 新错误码前端化（按 code 给重试/刷新/指引，非只 toast 原文）：BOM_VERSION_CHANGED、DAILY_UNIT_PRICE_CONFLICT、DAILY_REPORT_DUPLICATE_TARGET、VERSION_CONFLICT、OUTSOURCE_RECEIPT_QUANTITY_EXCEEDED、QC_*_EXCEEDED、UNIQUE_VALUE_CONFLICT、VALIDATION_ERROR（字段级 details）等。
  6. QC 收口：updateSubmission FOR UPDATE+锁内复核；createQcRecord/correctQc 对 transfer 锁内重读；多 submission 共享 finishedGoodsQcStatus 的取消重置语义；QC 全拒是否扣“已交付”/阻塞完工。
  7. 代码级修补：outsource batch create 事务化+锁 PO item；子生产单 create 锁父行（R1-3）；UpdateProductionOrderDto.unit_id 二选一（落实或移除）；QC domain Error→422；listSources 按状态过滤；employee 合并溢出与金额积护栏、统一 parseDecimal；采购 setXActive 补审计。
- **P2（待产品确认/测试）**：外协直发=完工凭据、回厂与直发互斥、主数据 RBAC（admin vs 物控）、已取消工序纠错口径、完工后补录口径、closed 恢复、计时单价量纲、payroll-sources 语义；补并发集成测试（op↔order 死锁对、40P01/P2034、correctQc 并发、短收+冲销收敛、僵尸告警清洗、user_id 双绑、batch 放大竞态）并把 tsc 纳入 CI。
- **数据/回归**：HR 页启用/复职入口 + 导入 partial 文案/按行去重错误数；清空可选键发 null；QC 快捷流先 submit 或提示；E2E：领料新建/编辑、外加工三按钮、QC 快速流、日报版本冲突更正四条手工/浏览器回归。
