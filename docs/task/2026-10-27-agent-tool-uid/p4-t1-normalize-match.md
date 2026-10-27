## 1. Where this task sits

- **阶段 4 查不到也说得清楚**，目标是大小写与空白差异不再把结果打成 0 条。
- **本任务推进 R-4 单号检索归一**：检索词与单号都先归一，再匹配。
- **Starts after**：阶段 3 全部。**Waits on it**：任务 7 空结果上下文、任务 9 回归。

## 2. What the developer needs to know

**Read first**

- `tools/order-query-tools.ts:40-56` — 现有检索是 `contains`，大小写敏感。
- `tools/order-root.ts:24-31` — 根验证是精确等值。
- `docs/review/agent-runtime-forensics-2026-10-26.md:168-173` — 单号里带产品名与空格的真实样本。

**Settled**

- 归一只有三件事：去首尾空白、合并连续空白、忽略大小写。
- 归一用在检索与根验证两处，不改写库里的值。
- 不做拼音、同音字、模糊纠错。

**Edges and seam**

- 触碰检索实现与根验证，不碰编排器与前端。
- Seam：现有的领域测试文件（检索与根验证各有覆盖）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/`

**Unknowns**

- 忽略大小写会让单号上的普通索引失效。若数据量导致明显变慢，停下来商量是否加表达式索引。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 写一个归一函数，检索与根验证都用它。
4. 用例 2 到 4 红后转绿。
5. 跑 API 单测。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 小写 `dl260170` | 命中 `DL260170-4H 伞头` | 检索 |
| 2 | 中间双空格的关键字 | 与单空格命中一致 | 检索 |
| 3 | 根验证收到小写单号 | 命中真实单 | 根验证 |
| 4 | 库中不存在的号 | 仍然 0 行 / 404 | 两处 |
