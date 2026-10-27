## 1. Where this task sits

- **阶段 5 把关系键从单号换成外键**，目标是证明「改号不会再打断关系」。
- **本任务推进 R-8 27 张表补外键并回填**：验证改号之后外键仍指向同一张销售单。
- **Starts after**：任务 4 其余链路。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `sales-order-order-no.ts:190-227` — 改号事务的顺序：先扫全链、再改源头、最后残留校验。
- `apps/api/test/unit/sales-order-order-no-rename.test.cjs` — 现有改号守卫断言什么。
- 本次迁移的回填口径 — 外键由 `order_no` 关联得到，改号只改文本。

**Settled**

- 改号仍然要扫 `order_no` 文本（它是显示键），本任务不改这一点。
- 新列在改号事务里**不该被动到**：它指向的是同一张销售单。
- 验收是「改号前后 `sales_order_id` 不变」，不是「登记表变短」。

**Edges and seam**

- 只加测试，不改改号实现。
- Seam：`sales-order-order-no-rename.test.cjs` 现有内存桩。

**Run**

- `node --test apps/api/test/unit/sales-order-order-no-rename.test.cjs`

**Unknowns**

- 计划原文是「把改号联动登记表缩到只剩历史与手工单据」。文本键仍要扫，所以这条做不到；
  按「改号后外键不变」验收，若要求登记表真的变短，停下来问产品口径。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 写用例 1：改号后 `sales_order_id` 不变。
3. 补用例 2、3：旧号文本已更新、外键仍指向原单。
4. 跑测试与 typecheck。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 改号 `DL1 → DL2` | 下游行的 `sales_order_id` 不变 | 内存桩 |
| 2 | 同一场景 | 下游行的 `order_no` 文本变成 `DL2` | 内存桩 |
| 3 | 同一场景 | 残留校验仍通过（旧号 0 行） | 内存桩 |
