# 任务 1：锁定修订证据门禁

## 1. 任务位置

- 属于阶段一 `R-3 失败返工可追溯`，目标是旧哈希的验证结果不能放行新修订。
- 本任务建立候选修订与 Validator 证据的最小确定性判定。
- 开始条件是 R-2 双子会话已通过；Activation 记录与真实返工等待本任务之后。

## 2. 开发者须知

**先读**

- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — `h1/h2` 的独立预期是什么。
- `apps/coding-worker/src/runtime-contract.ts` — Worker 模块的输入校验风格是什么。
- `apps/coding-worker/test/runtime-contract.test.ts` — 当前行为测试如何组织。

**已定**

- 当前候选只接受同一能力、同一代码哈希的 `approved` 证据。
- `rejected`、缺失验证、能力不匹配和旧哈希通过都不放行。
- 本任务只判定证据，不生成代码哈希，也不发布候选。

**边缘与接缝**

- 接触 `apps/coding-worker/src` 与对应测试。
- 接缝是纯 Worker 证据判定函数；不修改 Harness 或 ERP 门禁。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- revision-evidence`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若计划没有定义某种拒绝原因，返回稳定的机器原因，不扩展发布策略。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为 `h1` 拒绝写红测试。
3. 实现最小证据判定，再跑绿。
4. 逐例加入旧哈希、能力不匹配和 `h2` 通过。
5. 运行目标测试和类型检查。
6. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 当前 `h1`，验证拒绝 `h1` | `validation-rejected` | 证据判定函数 |
| 2 | 当前 `h2`，验证通过 `h1` | `revision-mismatch` | 证据判定函数 |
| 3 | 能力 B 使用能力 A 的通过记录 | `capability-mismatch` | 证据判定函数 |
| 4 | 当前 `h2`，验证通过 `h2` | 接受 | 证据判定函数 |
| 5 | 缺少验证记录 | `validation-missing` | 证据判定函数 |

