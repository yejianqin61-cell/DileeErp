<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-7 的双向对账**：能力表与目录规格任一边多出或缺少，测试即红；对账函数本身也被证明不会恒绿。
- **Starts after**：任务 1、2。**Waits on it**：无（任务 7 不依赖它）。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — 任务 1 里 `buildCatalog` 的「缺规格即抛错」，本任务把它升级成两个方向。
- `apps/api/test/unit/agent-tool-catalog-audit.test.cjs` — P1 盯住 35 个 operation 与领域测试覆盖的同一种模式；沿用其写法，不另创风格。
- `apps/web/lib/agent-tool-labels.test.mjs` — 前端标签对账的做法：以后端源码为真源、少一边就红。

**Settled**

- 新增纯函数 `reconcileCatalog(capabilities, operationSpecs, moduleSpecs)`，返回 `{missingOperationSpecs, orphanOperationSpecs, missingModuleSpecs, orphanModuleSpecs}` 四个字符串数组（元素是 `tool:operation` 或工具名）。
- `buildCatalog` 在内部调用它，**任何一个数组非空即抛错**，错误信息列出四个数组的内容。
- 真源方向：能力表是真源；规格、模块声明都是被核对方。
- 「故意删一侧，测试变红」用**局部拷贝**实现，不得改动真实数据或真实文件。

**Edges and seam**

- 改 `tool-catalog.ts`；新增 `agent-tool-catalog-reconcile.test.cjs`。不改规格内容。
- Seam：`reconcileCatalog`、`buildCatalog`、`TOOL_CAPABILITIES`、`OPERATION_SPECS`、`MODULE_SPECS`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-catalog-reconcile.test.cjs apps/api/test/unit/agent-tool-catalog.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若真实数据上对账就红（说明任务 1 或 2 漏了条目或多了孤儿），**停下报告**，不要在本任务里改规格内容凑绿。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1，红（函数还不存在），再实现 `reconcileCatalog`。
3. 把 `buildCatalog` 改成调用它，既有的任务 1 用例 7 必须仍绿。
4. 逐个转绿用例 2 至 5。
5. 跑 Run 的两条命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 真实 `TOOL_CAPABILITIES`、`OPERATION_SPECS`、`MODULE_SPECS` | 四个数组全空；规格键数为 35；模块声明恰为 `AGENT_TOOLS` 的六项（来源：`agent-tool-registry.test.cjs`） | `reconcileCatalog` |
| 2 | 能力表局部拷贝里多一条 `order_query:made_up` | `missingOperationSpecs` 恰为 `["order_query:made_up"]`，其余数组为空 | `reconcileCatalog` |
| 3 | 规格局部拷贝里多一条 `order_query:ghost` | `orphanOperationSpecs` 恰为 `["order_query:ghost"]` | `reconcileCatalog` |
| 4 | 模块声明拷贝里删掉 `finance_query`；再另起一个多一条 `ghost_query` | 前者 `missingModuleSpecs` 为 `["finance_query"]`；后者 `orphanModuleSpecs` 为 `["ghost_query"]` | `reconcileCatalog` |
| 5 | 对上面用例 2、3、4 的三种坏拷贝调用 `buildCatalog` | 都抛错，错误信息含对应的 key | `buildCatalog` |

</task-brief>
