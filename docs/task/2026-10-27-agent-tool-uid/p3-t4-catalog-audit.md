## 1. Where this task sits

- **阶段 3 任何单号都能进**，目标是新增能力不会绕过目录审计。
- **本任务推进 R-1 采购单号与生产单号入口**：把 32 项能力纳入目录与覆盖映射。
- **Starts after**：任务 1、任务 3。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `agent-tool-catalog-audit.test.cjs:9-28` — 24 个非财务、7 个财务、根查询分发表的断言。
- `agent-tool-catalog-audit.test.cjs:41-56` — 每个 operation 必须映射到一个领域测试。
- `tools/tool-registry.ts` 的 `visibleTools` — 档位决定模型可见工具。

**Settled**

- 总数 32：非财务 25、财务 7。
- 两个检索类 operation 都不在根查询分发表里。
- 覆盖映射把新能力登记到任务 1 新建的测试文件。

**Edges and seam**

- 只碰目录审计测试，不改实现。
- Seam：`agent-tool-catalog-audit.test.cjs`。

**Run**

- `node --test apps/api/test/unit/agent-tool-catalog-audit.test.cjs`

**Unknowns**

- 若发现别的测试也硬编码了 31，一并更新并在提交正文里列出来。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 改断言到 32/25/7，跑红（实现已就绪时应即时转绿）。
3. 更新覆盖映射。
4. 跑该测试，再跑一遍 API 单测确认没有遗漏的 31。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 能力总数 | 32 | 目录审计 |
| 2 | 非财务与财务分组 | 25 / 7 | 目录审计 |
| 3 | 根查询分发表 | 30 项，不含两个检索 operation | 目录审计 |
| 4 | 覆盖映射 | 并集等于 32 项 | 目录审计 |
