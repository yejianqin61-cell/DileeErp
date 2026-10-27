## 1. Where this task sits

- **阶段 3 任何单号都能进**，目标是界面不再显示「问采购却查销售」。
- **本任务推进 R-3 文案写明销售单号**：模型侧描述改口径，界面标签补新 operation。
- **Starts after**：任务 1 新增按号检索任意单据的 operation。**Waits on it**：任务 4 目录审计。

## 2. What the developer needs to know

**Read first**

- `deepseek-llm-provider.ts:20-27` — 六个工具描述，现在写的是「先调用 search_orders」。
- `apps/web/lib/agent-tool-labels.ts:23-62` — 31 项 operation 的中文标签。
- `apps/web/lib/agent-tool-labels.test.mjs:25-30` — 断言操作数量与标签覆盖率。

**Settled**

- 入口描述统一写成「先调用 search_documents」，并说明三类单号都能搜。
- 新增 `search_documents` 标签「单号检索」；`search_orders` 标签保留「销售订单」不变。
- 界面文案总数从 31 变 32。

**Edges and seam**

- 触碰 provider 描述与前端标签表；不碰渲染组件。
- Seam：provider 单测的描述断言 + 前端标签覆盖测试。

**Run**

- `node --test apps/api/test/unit/agent-deepseek-provider.test.cjs apps/web/lib/agent-tool-labels.test.mjs`

**Unknowns**

- 若前端测试用的 operation 清单是硬编码的，必须跟着改；若是从后端导入则自动跟随。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先改前端标签测试与 provider 描述断言，跑红。
3. 更新描述与标签表。
4. 两处测试转绿，跑 typecheck。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 订单工具描述 | 出现「先调用 search_documents」 | provider 单测 |
| 2 | 订单工具描述 | 说明销售单号、采购单号、生产单号都能搜 | provider 单测 |
| 3 | 标签表 | 含 `search_documents` 且为「单号检索」 | 标签测试 |
| 4 | 标签总数 | 32 | 标签测试 |
