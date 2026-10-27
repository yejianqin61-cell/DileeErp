## 1. Where this task sits

- **阶段 2 一条只靠 uid 走通的链路**，目标是对同一张单追问时第二个工具参数里没有单号原文。
- **本任务推进 R-2 根查询改用 uid 派生句柄**：先让模型看得见 `order_ref` 这个入口。
- **Starts after**：阶段 1 全部。**Waits on it**：任务 6 检索结果带句柄并登记。

## 2. What the developer needs to know

**Read first**

- `deepseek-llm-provider.ts:20-43` — 六个工具描述与输入 schema 的写法。
- `agent-deepseek-provider.test.cjs` — 现有对 schema 与描述文本的断言风格。
- `agent-tool-executor.ts:41-51` — 输入解析拒绝额外字段，说明 ref 必须在编排层消化。

**Settled**

- `order_ref` 与 `order_no` 并存，`order_no` 保留为兼容。
- schema 只加属性，不加必填。
- 描述里写明「根查询优先用 order_ref」，不再要求模型复制单号原文。

**Edges and seam**

- 只碰 provider 与其单测，不碰编排器。
- Seam：`agent-deepseek-provider.test.cjs` 现有断言。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-deepseek-provider.test.cjs`

**Unknowns**

- 描述一改模型行为就变，若测试里出现「描述必须逐字等于某句」的断言，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. schema 增加 `order_ref` 属性并更新描述。
4. 用例 2 到 4 红后转绿。
5. 跑该测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 取六个工具的输入 schema | 都含 `order_ref` 属性 | provider 单测 |
| 2 | 取 `order_ref` 的属性描述 | 含「检索」与「句柄」字样 | provider 单测 |
| 3 | 取 `order_no` 属性 | 仍在，未被删除 | provider 单测 |
| 4 | 取 `required` | 仍只有 `operation` | provider 单测 |
