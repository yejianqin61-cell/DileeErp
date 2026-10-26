## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：发布前能判定 Agent 配置是否完整。
- **本任务推进 R-13 可发布与可回退**：把生产环境的必要条件写成可运行闸门。
- **开始于** Phase 5 完成。**后续等待它**：预发布部署与真实模型验收。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/platform/config/validate-environment.ts` — 已有生产必填项。
- `scripts/deploy-incremental.ps1` — 部署时怎样调用检查。
- `scripts/apply-migrations.ps1` — 迁移的现有发布入口。
- `scripts/deploy-scripts.test.mjs` — 部署脚本已有可执行约束。

**Settled**

- 生产必须使用 DeepSeek、两组 Agent 数据库凭据和部署迁移。
- 不输出密钥、连接串或真实问题全文。

**Edges and seam**

- 触及既有发布脚本与检查。保留应用运行时语义。

**Run**

- `npm run test:deploy`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 若脚本没有生产配置入口，记录缺口并停止新增部署方式。

## 3. The workflow

1. 阅读第 2 部分并复述：发布前必须拒绝不完整 Agent 配置。
2. 写一个失败检查，覆盖缺少 Agent 发布条件。
3. 复用现有部署脚本加入最小发布前检查。
4. 运行部署脚本测试。
5. 运行 API 类型检查。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 缺只读连接 | 发布拒绝 | 部署预检 |
| 2 | 缺状态连接 | 发布拒绝 | 部署预检 |
| 3 | fake provider | 生产发布拒绝 | 部署预检 |
| 4 | 配置完整 | 检查通过 | 部署预检 |
