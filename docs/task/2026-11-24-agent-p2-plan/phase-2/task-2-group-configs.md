<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务交付三组的提示与 `report_gap` 声明**：A（自由文本）、B（四轴坐标）、C（最近邻差异），以及只记录的假 `report_gap`。
- **Starts after**：无。**Waits on it**：任务 3。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/phase-2/README.md` — 「共用文案」：判据句、GAP_HINT、C/B 的追加段，逐字使用。
- `apps/api/src/modules/business-query-agent/tools/system-prompt.ts` — `buildSystemPrompt`，三组共同的底座。
- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §2.2、§2.7 — `report_gap` 的 C 方案参数；A/B 的定义。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — `TOOL_CAPABILITIES`，C 组 `nearest_operation` 的枚举来源。

**Settled**

- 三组的 `report_gap` 描述都以**判据句**开头，再接各自一句：A「说明原因。」；B「按四轴给出这个缺口的坐标：对象、度量、粒度、时间基准。」；C「从现有 operation 里选最接近用户问题的一个，并说明它差什么。」（README 共用文案；设计 §2.7）。
- A 的参数 `{reason: string}`；C 的参数 `{nearest_operation: enum(35 个 operation 名), missing: enum(group_by|filter|metric|time_series|object), missing_detail: string, needed_fields?: string[]}`；B 的参数 `{object, metric, granularity, time_basis}` 四个枚举，取值见下方轴表（设计 §2.2、v1.0 §2.2）。
- B 组轴声明六行，逐字如下，`buildSystemPrompt("full")` 与 GAP_HINT 之后接 `可用查询模块的轴声明：` 一行再接这六行（**待用户审**，只为实验，不入注册表）：
  - `order_query 对象：单据；度量：定位、状态、进度、时间、数量；粒度：单张明细（需单据根）、跨单行集；时间：当前快照、区间；不支持：分组汇总、趋势、写操作`
  - `sales_query 对象：单据、客户、物料；度量：定位、数量、状态；粒度：单张明细（需单据根）；时间：当前快照；不支持：分组汇总、趋势、金额`
  - `procurement_query 对象：单据；度量：定位、数量、状态、时间；粒度：单张明细（需单据根）、跨单行集；时间：当前快照；不支持：分组汇总、趋势、金额`
  - `production_query 对象：单据；度量：数量、进度、状态、时间；粒度：单张明细（需单据根）；时间：当前快照；不支持：员工与工价、分组汇总、趋势`
  - `warehouse_query 对象：单据、物料；度量：数量、状态；粒度：单张明细（需单据根）、跨单行集、分组汇总（仅按物料）；时间：当前快照；不支持：金额、趋势、按仓库`
  - `finance_query 对象：单据、客户、供应商、员工；度量：金额、状态、差异；粒度：单张明细（需单据根）；时间：当前快照；不支持：跨订单汇总、科目凭证、趋势`
- 轴取值（B 的枚举）：对象 `单据|物料|客户|供应商|员工|科目`；度量 `定位|数量|金额|状态|进度|时间|差异`；粒度 `单张明细|跨单行集|分组汇总|计数`；时间基准 `当前快照|区间|趋势`。
- 假 `report_gap`：把收到的参数原样追加到调用方给的数组，返回固定字符串 `已记录`；不校验、不驳回。

**Edges and seam**

- 新文件 `scripts/agent/gap-experiment/groups.mjs`，导出 `buildGroup(group)` 返回 `{ system, gapTool: {description, inputSchema}, record(args) }` 的等价结构（见 Seam）。不改任何 `src`。
- Seam：`buildGroup("A"|"B"|"C")` 的返回值，测试直接断言字符串与 schema。

**Run**

- `npm run build --workspace=@dilee/api && node --test scripts/agent/gap-experiment/groups.test.mjs`

**Unknowns**

- 若 `buildSystemPrompt("full")` 通过 `createRequire` 读 `dist` 报错（路径或编译产物缺失）：先 `npm run build --workspace=@dilee/api`；仍不行就停下报告，不要复制目录文案进脚本。
- 若 `apps/api/dist` 的 `TOOL_CAPABILITIES` 数量不是 35：停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（三组系统指令的共同底座与各自追加），红，再实现 `buildGroup` 的 `system`。
3. 写用例 2、3（三组 `report_gap` 的 schema 与描述），红，再实现 `gapTool`。
4. 写用例 4（假 `report_gap` 只记录），红，再实现。
5. 写用例 5（B 的六行轴声明与枚举），红，再补齐。
6. 跑 Run 的命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `buildGroup("A").system`、`B`、`C` | 三者都以 `buildSystemPrompt("full")` 的全文开头，且都含 GAP_HINT 原句；只有 C 含「先在上面的模块里找最接近用户问题的 operation」；只有 B 含「可用查询模块的轴声明：」（来源：README 共用文案） | `buildGroup` |
| 2 | 三组 `gapTool.description` | 都以判据句原文开头；A 以「说明原因。」结尾，B 含「四轴」，C 含「最接近」（来源：README 共用文案与本任务 Settled） | `buildGroup` |
| 3 | 三组 `inputSchema` 的 `properties` 键 | A 恰 `["reason"]`；B 恰 `["object","metric","granularity","time_basis"]`；C 恰 `["nearest_operation","missing","missing_detail","needed_fields"]`；C 的 `nearest_operation` 枚举长度 35，`missing` 枚举恰五项（来源：设计 §2.2；能力表 35 条） | `buildGroup` |
| 4 | 对 C 调两次 `record` | 两次的参数按序留在记录数组里；两次返回值都是 `已记录` | `buildGroup` |
| 5 | B 的 `system` | 含六行轴声明各自的行首模块名；`warehouse_query` 行含「不支持：金额、趋势、按仓库」；B 的 `object` 枚举恰六项、`granularity` 恰四项（来源：本任务 Settled） | `buildGroup` |

</task-brief>
