# Agent 工具调用审计：为什么所有工具都找不到订单

审计日期：2026-10-27
审计对象：HEAD `a71b704` 的已提交代码 + 2026-10-26 修复轮（`27a47e2`、`8238430`）的承诺 + 线上观察
范围：`apps/api/src/modules/business-query-agent/**` 的工具链、`apps/web/lib/agent-tool-labels.ts`
数据佐证：`.deploy-run-118/dilee_erp.sql.gz`（2026-09-17 表结构快照）、`docs/review/agent-*` 五份取证
局限：工作区有未跟踪文件（`docs/`、`.deploy-run-*`），本次对象是已提交代码与行为，不审未跟踪产物
两轴执行方式：本机顺序执行（Spec 先、Standards 后），未并行

## 1. 上一轮的要求

**本轮 7 条要求，交付 4 条，平均完成度 75%（22 个验收点通过 17 个）。**

| # | 要求 | 来源 | 交付 | 完成度 | 证据 |
|---|---|---|---|---|---|
| R-1 | 所有根查询以销售单为根 | 模块设计第 73 行 | Delivered | 100% | `tools/order-root.ts:24-31`；`tools/rooted-operations.ts:26-61` |
| R-2 | 根查询只接受本轮检索到的精确单号 | 架构第 118 行、`27a47e2` | Delivered | 100% | `agent-orchestrator.ts:198-209` |
| R-3 | 模型原样复制单号而不改写 | `27a47e2` 第 3 批 | Partial | 65% | `deepseek-llm-provider.ts:21-26` 只有文字指令，无强约束 |
| R-4 | 工具失败可回传、模型可自纠 | `27a47e2` 第 2 批 | Delivered | 100% | `agent-orchestrator.ts:144-149` |
| R-5 | 工具目录与注册表一致 | 架构第 80-91 行 | Delivered | 100% | `tools/tool-registry.ts:34-72`；分发表 30 项 + `search_orders` |
| R-6 | 调用可取证（参数、结果行数） | 模块设计第 165 行、取证 §4.3 | Partial | 75% | `observability.ts:16-18` 只有 operation/status/rows，无参数 |
| R-7 | 采购单号、生产单号也能作为入口 | 用户本轮反馈 | Not delivered | 0% | 全模块无按采购单号检索的 operation |

## 2. 本轮的缺陷

| ID | 轴 | 缺陷 | 位置 | 严重度 |
|---|---|---|---|---|
| **D-1** | Spec | 查询入口只有销售单，采购单号搜不到 | `tools/order-query-tools.ts:40-56` | **Blocking** |
| D-2 | Spec | 单号精确等值匹配，但单号里带产品名与空格 | `tools/order-root.ts:24-31` | Major |
| D-3 | Spec | 工具描述没说 `order_no` 是销售单号 | `deepseek-llm-provider.ts:21-26` | Major |
| D-4 | Spec | 搜索大小写敏感、不归一空格 | `tools/order-query-tools.ts:42` | Major |
| D-5 | Spec | 工具参数不落库，出问题无法定位 | `observability.ts:16-18` | Major |
| D-6 | Standards | 3 次可回传失败即整轮失败，无部分答案 | `agent-orchestrator.ts:147-149` | Minor |
| D-7 | Spec | 线上版本未签核，部署以健康检查 FAIL 收场 | `.deploy-run-118/deploy-a71b704.log:111` | Note |

已排除 registry 注册问题：`tool-registry.ts` 的 31 项与 `rooted-operations.ts` 的 30 项加 `search_orders` 完全对齐；`domainInputSchema` 按工具裁剪 operation 枚举（`deepseek-llm-provider.ts:30-43`）。注册没有问题。

### D-1 查询入口只有销售单，采购单号搜不到

- **Symptom**：问「采购单 PO-20260911-FEBD8A15 的情况」，Agent 先执行 `search_orders`，界面显示「销售订单」。
- **Evidence**：
  - `searchOrders` 只查 `salesOrder`，只按 `orderNo contains`（`tools/order-query-tools.ts:41-42`）。
  - 除它之外 30 个 operation 全部要求 `order_no` 是销售单号（`tools/rooted-operations.ts:26-61`）。
  - 采购实现按 `where: { orderNo }` 查，这个 `orderNo` 就是销售单号（`procurement-query-tools.ts:43-46`）。
  - 界面把 `search_orders` 标注为「销售订单」（`apps/web/lib/agent-tool-labels.ts:26`）。
- **Impact**：用户手里只有采购单号时，检索必然 0 行；`searchedOrderNos` 为空，后续每个根调用都被守卫拒绝，最终整轮 `AGENT_TOOL_RETRIES_EXHAUSTED`，用户看到的就是「所有工具都找不到」。
- **Criterion**：模块设计第 73 行把入口锁在销售单上，这是设计与提问方式不匹配，不是实现偏离。

### D-2 单号精确等值匹配，但单号里带产品名与空格

- **Symptom**：模型把 `DL260170-4H 伞头` 写成 `DL260170-4H`，根验证返回 `ORDER_NOT_FOUND`。
- **Evidence**：
  - `findFirst({ where: { orderNo, deletedAt: null } })` 是精确等值（`tools/order-root.ts:25-28`）。
  - 数据库对照：精确值 1 行、截断到空格 0 行、双空格 0 行（`agent-runtime-forensics-2026-10-26.md:168-173`）。
  - 守卫只比对集合成员，改写值不在集合内就换成 `ORDER_SEARCH_REQUIRED`（`agent-orchestrator.ts:205-207`）。
- **Impact**：守卫把 404 换成了「请重新搜索」，但不会把改写纠正回精确值；模型重复改写 3 次就整轮失败。
- **Criterion**：R-3 只靠提示词约束，没有代码层的容错或纠正。

### D-3 工具描述没说 order_no 是销售单号

- **Symptom**：问采购单，模型调 `search_orders`；用户看到的是「查了销售单」，与问题不对应。
- **Evidence**：六个工具描述只写「`order_no` 必须是本轮 `search_orders` 返回的精确值」（`deepseek-llm-provider.ts:21-26`）；字段说明写「当前订单号；订单搜索以外的 operation 必填」（`:36`），没有一处说它是销售单号。
- **Impact**：模型与用户都按业务对象理解「订单号」，采购单号、生产单号被当成合法入口投进去。
- **Criterion**：R-3 的文字要求覆盖了取值来源，没有覆盖单据类型。

### D-4 搜索大小写敏感、不归一空格

- **Symptom**：用户输入 `dl260170` 或带多余空格的单号，`search_orders` 返回 0 行。
- **Evidence**：`where: { orderNo: { contains: input.q } }`（`order-query-tools.ts:42`），Prisma 在 PostgreSQL 上生成 `LIKE '%q%'`，大小写敏感且不做空白归一；`parseSearchOrdersInput` 只 `trim` 首尾（`:33`）。
- **Impact**：一个字符的大小写差异就让整轮无数据，且错误表现为「查不到」，不是「参数不合法」。
- **Criterion**：R-7 要求任意单号可进；当前只接受与库中完全一致的写法。

### D-5 工具参数不落库，出问题无法定位

- **Symptom**：事后无法回答「模型到底传了什么 order_no / q」，只能靠猜。
- **Evidence**：`tool_executed` 事件只有 operation、status、result_rows（`observability.ts:16-18`）；SSE 的 `tool_status` 同样不带参数（`apps/web/lib/agent-tool-labels.ts:4-7` 注释自述）；取证报告 §4.3 已记录同一结论。
- **Impact**：本轮四个候选原因（口径、参数、策略、注册）里，只有参数这一类无法用现有证据排除。
- **Criterion**：模块设计第 165 行要求「日志默认不含工具参数」，但缺少脱敏后的参数摘要这一层。

### D-6 3 次可回传失败即整轮失败，无部分答案

- **Symptom**：模型猜三次单号后整轮 `failed`，已拿到的检索结果也被丢弃。
- **Evidence**：`recoverableFailures >= AGENT_MAX_RECOVERABLE_TOOL_FAILURES` 直接抛 `AGENT_TOOL_RETRIES_EXHAUSTED`（`agent-orchestrator.ts:147-149`）；`answer` 只在 `completed` 分支写入（`:176-182`）。
- **Impact**：用户看到「什么都查不到」，而系统其实已经知道「按这个关键字搜到了 0 行」。
- **Criterion**：`27a47e2` 的第 2 批只要求「失败可回传」，没有要求「失败也能出部分答案」。

### D-7 线上版本未签核

- **Symptom**：无法确认线上跑的到底是哪一版，「真实环境」的复现前提不成立。
- **Evidence**：`deploy-a71b704.log` 最后一行 `FAIL: health 返回的 build((health-failed)) 与 RELEASE_VERSION 不一致`（`:111`），原因是健康检查在 API 启动约 13 秒时执行（评审 `agent-invocation-audit:270` 已登记同一竞态）。
- **Impact**：a71b704 只有 Web 改动，但部署脚本判 FAIL 后没有回滚记录，线上状态处于「已切换、未签核」。
- **Criterion**：Phase 6-T5 要求发布验收留痕，本次发布没有。

## 3. 改进计划

### P-1 ← D-1 增加采购单号入口

- **What to build**：新增 `procurement_query/search_purchase_orders`，按采购单号检索并返回所属销售单号；模型拿到销售单号后再走现有根查询。
- **Touches**：`tools/procurement-query-tools.ts`、`tools/tool-registry.ts`、`tools/rooted-operations.ts`、`deepseek-llm-provider.ts`、目录审计测试。
- **Acceptance**：[ ] PO 号能返回对应销售单号　[ ] 后续根查询用返回的销售单号　[ ] 目录断言从 31 更新为 32。
- **Blocked by**：无。
- **Out of scope**：生产单号、到货单号入口，另开一轮。

### P-2 ← D-2 根验证容错

- **What to build**：精确未命中时按 trim、合并连续空格、大小写不敏感再查一次；只命中一行才放行，多行返回候选让模型重新搜索。
- **Touches**：`tools/order-root.ts`、`agent-orchestrator.ts` 的守卫。
- **Acceptance**：[ ] `DL260170-4H` 能命中 `DL260170-4H 伞头`　[ ] 多行命中时返回候选而不执行　[ ] 现有精确匹配用例保持绿。
- **Blocked by**：无。

### P-3 ← D-3 文案写明单据类型

- **What to build**：`order_no` 字段说明与六个工具描述改成「销售单号」，并在界面把 `search_orders` 标注为「销售单号检索」。
- **Touches**：`deepseek-llm-provider.ts`、`apps/web/lib/agent-tool-labels.ts`。
- **Acceptance**：[ ] 模型侧三处文案出现「销售单号」　[ ] 界面步骤条显示「销售单号检索」。
- **Blocked by**：无。

### P-4 ← D-4 搜索归一

- **What to build**：`q` 与 `orderNo` 都做 trim、合并空白与大小写不敏感匹配（Prisma `mode: "insensitive"`）。
- **Touches**：`tools/order-query-tools.ts`、`tools/order-root.ts`。
- **Acceptance**：[ ] 小写单号能命中　[ ] 多余空格能命中　[ ] 新增两条回归用例。
- **Blocked by**：P-2 的归一函数，同一文件区域。

### P-5 ← D-5 参数摘要落库

- **What to build**：`tool_status` 事件与 `tool_executed` 观测增加 `args_digest`，只记 `operation`、`order_no`、`q`、`page`。
- **Touches**：`agent-orchestrator.ts`、`observability.ts`、`state-manager.ts` 的事件负载。
- **Acceptance**：[ ] 每次工具调用可从事件还原入参　[ ] 日志仍不含查询结果与答案正文。
- **Blocked by**：无。

### P-6 ← D-6 失败也出部分答案

- **What to build**：失败预算耗尽时不再整轮 `failed`，用已取得的事实生成降级回答，明确写出「按 X 检索到 0 条」。
- **Touches**：`agent-orchestrator.ts`。
- **Acceptance**：[ ] 检索 0 行时答案说明检索词与 0 结果　[ ] 已取得的事实在失败时仍进入答案　[ ] 现有失败用例改写并保持绿。
- **Blocked by**：P-5 的参数摘要，同一段落。

### P-7 ← D-7 部署健康检查带重试

- **What to build**：`remote-switch.sh` 的健康检查改成最多 6 次、间隔 5 秒；日志同时打印 build 与 release。
- **Touches**：`scripts/deploy/`。
- **Acceptance**：[ ] API 冷启动 30 秒内能判成功　[ ] 失败日志同时含 build 与 release。
- **Blocked by**：无。

## 变更记录

- 2026-10-27：基于 HEAD `a71b704`、2026-09-17 库快照与五份取证报告创建本审计。
