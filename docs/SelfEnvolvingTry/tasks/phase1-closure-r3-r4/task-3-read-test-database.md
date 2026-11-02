## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是宿主能从专用脱敏测试库读取独立业务事实。
- **R-4 受限入口能安全读取实库**：实现只读 adapter，返回日产量和员工累计的最小投影。
- **Starts after**：R-1 测试库。**Waits on it**：宿主授权数据通道。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/restricted-data-gateway.ts` — 允许操作和投影字段。
- `apps/coding-worker/src/phase1-data-baseline.ts` — 固定测试库来源与命名。
- `apps/api/prisma/schema.prisma` — 员工日报真实列和软删除口径。
- `phase1-closure-design-and-build-plan-2026-11-02.md` — R-4 的查询与泄露边界。

**Settled**

- 只读 adapter 只连接 `dilee_phase1_test`，不接受候选 SQL。
- 查询按订单和工序参数化，排除软删除，数量以数据库字符串返回。
- 工资、单价、金额和备注不进入 adapter 结果。

**Edges and seam**

- 触及 Worker 的 PostgreSQL adapter；不修改 API Prisma 客户端。
- 接缝是 `RestrictedDataAdapter`。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- postgres-restricted-data`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 专用只读账号尚未创建。若当前容器角色不能建立最小权限账号，先用受控测试 adapter 验证查询形状。

## 3. The workflow

1. 阅读第 2 部分，并重述：adapter 只返回允许字段的实库聚合。
2. 写 SQL 参数和投影的失败测试。
3. 实现参数化查询与输出解析，产出 adapter。
4. 在 `dilee_phase1_test` 跑实际只读聚合，产出脱敏计数。
5. 运行测试和类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 已知订单和工序 | 日行与员工累计 | `RestrictedDataAdapter` |
| 2 | 不存在范围 | 空数组 | `RestrictedDataAdapter` |
| 3 | 软删除日报 | 不出现在结果中 | `RestrictedDataAdapter` |
| 4 | 数量带小数 | 字符串数量不丢精度 | `RestrictedDataAdapter` |
| 5 | 结果行 | 不含金额和备注 | `RestrictedDataAdapter` |
