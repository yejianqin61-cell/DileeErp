<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-1 的数据与生成器、R-7 的单一真源、R-13 的候选集接口**：35 条 operation 的文案、六个模块的声明、一个从能力表生成目录的函数。
- **Starts after**：无。**Waits on it**：任务 2、3、4、6。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — `TOOL_CAPABILITIES` 的形状、`AGENT_TOOLS`、`visibleTools`。目录的结构全从这里来。
- `apps/api/src/modules/business-query-agent/tools/rooted-operations.ts` 与 `unrooted-operations.ts` — 哪些 operation 要单据根、哪些不要；写「输入要求」与「粒度」的依据。
- `apps/api/src/modules/business-query-agent/tools/{order-query,sales-query,procurement-query,production-query,warehouse-query,finance-query}-tools.ts` — 每个 operation 实际查什么、不查什么；写「边界」的唯一依据。
- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §3.1 — 五字段的定义与示例（`list_overdue_arrivals`）。

**Settled**

- 条目四个文案字段：`questionShape`、`input`、`output`、`boundary`。`name` 取自能力表，不重复存（设计 §3.1）。
- 没有 `status` 字段（README「本批已定」）。
- 模块声明字段：`tool`、`title`（中文模块名）、`scope`（一句「管什么」，必须点名该模块里无需单据根的入口）、`negatives`（否定清单，字符串数组）。
- 文案手写在 `tool-catalog-specs.ts`；`tool-catalog.ts` 只做生成与渲染，不含业务文案。

**Edges and seam**

- 新增 `tools/tool-catalog-specs.ts`、`tools/tool-catalog.ts`；**不改** `tool-registry.ts`、编排器、提供方。
- Seam（本任务定义，后续任务沿用）：
  `buildCatalog(capabilities = TOOL_CAPABILITIES, operationSpecs = OPERATION_SPECS, moduleSpecs = MODULE_SPECS)`、
  `renderL1(accessLevel, catalog = buildCatalog())`、
  `candidateOperations(question, accessLevel, catalog = buildCatalog())`（`question` 本任务不参与，返回按档位过滤后的全部条目，保持能力表顺序）。
  `catalog` 可注入，是为了让测试能替换能力表而不改全局。
- 规格 key 一律 `${tool}:${operation}`。能力表里有、规格里没有的 operation，`buildCatalog` 必须抛错，错误信息含这个 key。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-catalog.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 「边界」要写「不覆盖什么」，只能从执行器代码读出。读不出来的不要猜：把 operation 名记入任务报告的「待审」清单，该条 `boundary` 只写代码里确证的部分。**不得编造能力或限制。**
- L1 长度预算是 400 token。仓库里没有 token 计数器，本任务用「`renderL1("full")` 不超过 600 字符」作保守代理；若写不进 600 字符，停下报告，不要删「否定清单」凑数。

## 3. The workflow

1. 读 part 2 的四个入口，用一句话复述本任务。
2. 先写测试文件 `apps/api/test/unit/agent-tool-catalog.test.cjs` 的用例 1，红。
3. 建 `tool-catalog-specs.ts`：先写六个模块声明，再逐模块写 operation 条目（每写完一个模块跑一次类型检查）。
4. 建 `tool-catalog.ts`：`buildCatalog`、`renderL1`、`candidateOperations`；缺规格即抛错。
5. 逐个转绿用例 2 至 6，每次一个。
6. 跑 Run 里的两条命令。
7. 提交。任务报告附「待审」清单。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `renderL1("full")` | 含六个模块标题；每个模块行里的 operation 数依次为 8、4、5、4、7、7（`order/sales/procurement/production/warehouse/finance`，来源：`agent-tool-registry.test.cjs` 既有断言） | `renderL1` |
| 2 | `renderL1("operational")` | 只有五个模块，文本里没有 `finance_query` 也没有「财务」模块行 | `renderL1` |
| 3 | `candidateOperations("任意问句", "full")` / `("任意问句", "operational")` | 长度 35 / 28（来源：`agent-tool-catalog-audit.test.cjs`）；第二个结果里没有任何 `tool === "finance_query"` | `candidateOperations` |
| 4 | 35 个条目 | 四个文案字段全部是非空字符串 | `buildCatalog` |
| 5 | `list_overdue_arrivals` 的 `boundary` | 含「供应商」（来源：设计 §3.1 示例「不按供应商分组」） | `buildCatalog` |
| 6 | `renderL1("full")` | 长度不超过 600 字符；且文本含 `list_documents`、`list_low_stock_materials`、`list_overdue_arrivals` 三个入口名（来源：现有系统指令第 27 行点名的三个无根入口） | `renderL1` |
| 7 | `buildCatalog` 传入多一条无规格的 capability | 抛错，信息含该 key | `buildCatalog` |

</task-brief>
