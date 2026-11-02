## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是让真实模型和本地脱敏数据能在受控边界相遇。
- **R-1 本地数据基线可重复**：建立只从快照库复制的专用测试副本，并输出冻结清单和独立预期值。
- **Starts after**：无。**Waits on it**：R-4 受限入口读取实库和阶段验收入口。

## 2. What the developer needs to know

**Read first**

- `phase1-closure-design-and-build-plan-2026-11-02.md` — R-1 的范围、样例和不可写原库条件。
- `apps/coding-worker/src/restricted-data-gateway.ts` — 要为后续入口准备的行和汇总口径。
- `apps/api/prisma/schema.prisma` — 员工日报、生产单和工序的真实列名。
- `docs/deployment/prod-snapshot-for-testing.md` — 既有快照及脱敏来源。

**Settled**

- 数据来源固定为本地 `dilee_snapshot`，`dilee_erp` 与源快照不写入。
- 专用库名由调用者显式传入，默认值必须带 `test`，其他名称拒绝。
- 清单只存哈希、计数和样例键，不存姓名、备注或连接凭据。

**Edges and seam**

- 触及 Coding Worker 的本地 Docker/psql 测试准备模块；不触及 API 业务库连接。
- 接缝是 Worker 的宿主测试准备入口，后续 R-4 只消费它的基线结果。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- phase1-data-baseline`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 快照表的外键是否允许只复制最小业务集合。若不能在单事务内恢复并补样例，停止并报告依赖表。
- 数据库账号若没有建库权限，停止并报告权限名，不读取或输出密码。

## 3. The workflow

1. 阅读第 2 部分，并用一句话重述本任务：从快照建立可核验、可丢弃的测试副本。
2. 为不安全目标库名和源库保护写失败测试，产出失败断言。
3. 实现受限目标名、快照校验和清单计算，产出确定性基线描述。
4. 加入克隆后独立聚合预期值与补充样例标记，产出可消费的测试库结果。
5. 写实库集成测试，只读核对源库并在专用库验证重建结果。
6. 运行本任务命令和类型检查，产出通过记录。
7. 提交本任务。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 目标为 `dilee_erp` | 创建前拒绝 | 基线准备入口 |
| 2 | 目标不含 `test` | 创建前拒绝 | 基线准备入口 |
| 3 | 同一快照重建两次 | 清单哈希和计数相同 | 基线准备入口 |
| 4 | 包装样例不足两名员工 | 副本有明确标记补充样例 | 基线准备入口 |
| 5 | 源快照与业务库 | 行数和校验值未变化 | 独立 SQL 聚合 |
