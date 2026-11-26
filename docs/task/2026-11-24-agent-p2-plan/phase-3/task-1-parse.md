<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务交付 R-4 缺口声明工具的格式校验**：把模型传来的参数解析成一个类型化声明，不合法就抛可读的 422。
- **Starts after**：无。**Waits on it**：任务 3、4。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/phase-3/README.md` — 字段、取值、错误码。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — `CATALOG_TOOL` 常量与 `AgentCallableToolName` 的写法，照此加两个常量。
- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — `describeModule` 抛 `UnprocessableEntityException {code,message,details}` 的形状。

**Settled**

- `tool-registry.ts` 加 `GAP_TOOL = "report_gap"`、`DECLARE_GAP_OPERATION = "declare_gap"`，并把 `GAP_TOOL` 并入 `AgentCallableToolName`。**不得**改动 `row("tool", "op"` 的写法（前端标签测试用正则解析）。
- `missing` 枚举：`group_by|filter|metric|time_series|object`；`missing_param` 枚举：`q|status|customer_q|product_q|from|to`（README）。两个枚举从本文件导出。
- 长度上限：`missing_detail` 去首尾空白后 1–200 字（实验里最长 86）；`needed_fields` 至多 20 项，每项 1–100 字。`missing_detail` **不得包含整句用户原话**（`question.trim()` 非空且是它的子串即拒）。
- 参数里的 `operation` 键忽略；其它未知键一律拒。错误 `code` 恒为 `AGENT_GAP_ARGUMENT_INVALID`，message 点名出错字段；枚举错误时列出全部合法值（顿号分隔）。

**Edges and seam**

- 新文件 `tools/report-gap.ts`，导出 `parseGapDeclaration(args, question)`；只改 `tool-registry.ts` 的常量与类型。不碰编排器与提供方。
- Seam：`parseGapDeclaration` 纯函数。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-parse.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 扩大 `AgentCallableToolName` 后 typecheck 在别处报错：停下报告报错位置，不要用类型断言压掉。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（合法声明），红，再加常量与解析函数。
3. 写用例 2、3（缺必填、枚举外），红，再补校验。
4. 写用例 4（原话与长度），红，再补。
5. 写用例 5（未知键与 `operation`），红，再补。
6. 跑 Run 的命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `{nearest_operation:"list_low_stock_materials",missing:"group_by",missing_detail:" 按仓库分组 "}`，原话「各仓库库存多少」 | 返回同名字段，`missing_detail` 为「按仓库分组」，`needed_fields` 为 `[]`，无 `missing_param` 键（来源：设计 §2.2 示例） | `parseGapDeclaration` |
| 2 | 分别缺 `nearest_operation`、`missing`、`missing_detail` | 三次都抛 422，`code` 为 `AGENT_GAP_ARGUMENT_INVALID`，message 含所缺字段名 | 同上 |
| 3 | `missing:"sort"`；另一次 `missing_param:"page"` | 都抛同一 code；前者 message 含「group_by、filter、metric、time_series、object」，后者含「q、status、customer_q、product_q、from、to」 | 同上 |
| 4 | `missing_detail` 为「请问各仓库库存多少呢」且原话为「各仓库库存多少」；另一次长度 201 字 | 两次都抛同一 code；长度恰 200 字时通过 | 同上 |
| 5 | 合法声明外加 `question:"x"`；另一次外加 `operation:"declare_gap"` | 前者抛同一 code，message 含 `question`；后者通过且结果里没有 `operation` | 同上 |

</task-brief>
