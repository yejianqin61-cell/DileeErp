## 1. Where this task sits

- **阶段 3 任何单号都能进**，目标是同一个关键字命中多类单据时不乱序、不重复。
- **本任务推进 R-1 采购单号与生产单号入口**：定死同号跨表的解析顺序与去重规则。
- **Starts after**：任务 1 新增按号检索任意单据的 operation。**Waits on it**：任务 5 端到端。

## 2. What the developer needs to know

**Read first**

- `tools/order-query-tools.ts:40-56` — 现有检索的排序与分页口径。
- `agent-orchestrator.ts` 的 `registerSearchResults` — 句柄按命中顺序发放，重复单号复用。
- `prisma/schema.prisma` 中 `PurchaseOrder` 与 `ProductionOrder` 的 `orderNo` 字段。

**Settled**

- 顺序固定：销售单 → 采购单 → 生产单，同一类型内按更新时间倒序。
- 同一张销售单只出现一次：采购单与生产单命中的行折叠到它的销售单上。
- 总数仍然最多 20 行，折叠发生在截断之后。

**Edges and seam**

- 只碰检索实现与其测试，不碰执行器与编排器。
- Seam：任务 1 新建的领域测试文件。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-document-search.test.cjs`

**Unknowns**

- 若一张销售单同时被三类单据命中，保留哪一行的单据类型需要产品口径；默认保留销售单行，其余折叠为附加信息。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1：同一关键字命中销售单与采购单，销售单在前。
3. 实现顺序与折叠。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 关键字同时命中销售单与采购单 | 销售单行在前 | 执行器 |
| 2 | 采购单与生产单指向同一张销售单 | 该销售单只出现一次 | 执行器 |
| 3 | 命中 30 行 | 截断到 20 行 | 执行器 |
| 4 | 三类都命中 | 顺序为销售、采购、生产 | 执行器 |
