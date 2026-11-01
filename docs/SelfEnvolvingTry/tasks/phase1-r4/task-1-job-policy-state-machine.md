# 任务 1：定义作业动作状态机

## 1. 任务位置

- 属于阶段一 `R-4 Cordis 与 Worker 强制规则`，目标是规则层拥有动作次序和返工预算。
- 本任务建立单能力从声明、构建、验证、返工到候选提交的确定性状态机。
- 开始条件是 R-3 修订证据门禁已完成；Cordis 接线和 Worker 截止时间等待本任务。

## 2. 开发者须知

**先读**

- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — R-4 的独立预期是什么。
- `apps/coding-worker/src/revision-evidence.ts` — 当前稳定拒绝原因怎样表达。
- `apps/coding-worker/test/revision-evidence.test.ts` — 纯规则接缝的行为测试怎样组织。

**已定**

- 合法次序是声明能力、Builder 完成、Validator 审当前哈希、记录结论、返工或提交。
- 返工必须沿原 Builder，且次数不能超过作业配置。
- 同哈希重验、运行中提交和缺少当前通过记录都失败关闭。

**边缘与接缝**

- 接触 `apps/coding-worker/src` 与对应单元测试。
- 接缝是纯作业策略对象；不启动 Harness，不读取候选文件，也不执行发布。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- job-policy`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若一个动作需要计划未定义的新状态，停止并报告，不把发布门禁塞入本状态机。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为未声明能力启动 Validator 写红测试。
3. 实现最小合法状态迁移，再跑绿。
4. 逐例加入旧哈希、返工预算和缺验证提交。
5. 运行目标测试和类型检查。
6. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 未声明能力启动 Validator | `capabilities-not-declared` | 作业策略 |
| 2 | Builder 未完成就启动 Validator | `builder-not-complete` | 作业策略 |
| 3 | `h1` 拒绝后再次验证 `h1` | `revision-not-advanced` | 作业策略 |
| 4 | 达到返工上限后再返工 | `rework-budget-exhausted` | 作业策略 |
| 5 | 当前 `h2` 通过后提交 | 接受候选 | 作业策略 |

