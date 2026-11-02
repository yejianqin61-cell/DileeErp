## 1. Where this task sits

- **Phase 1 收口**，目标是门禁自行复验而不信任报告或回调。
- **R-5 ERP 独立重验整个候选**：在离线容器重跑测试和权限集。
- **Starts after**：冻结独立门禁输入。**Waits on it**：整批门禁。

## 2. What the developer needs to know

**Read first**

- `src/linux-isolation-probe.ts` — 固定离线容器边界。
- `src/candidate-gate.ts` — 现有回调型门禁。
- `src/container-policy.ts` — 只读挂载和最小环境。

**Settled**

- 门禁必须亲自执行候选测试和固定权限反例。
- Validator 报告只作绑定证据，不能替代复验。
- 任一复验失败返回拒绝，不产生候选报告。

**Edges and seam**

- 触及独立门禁运行器。
- 不开放网络、安装脚本或生产凭据。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- independent-gate`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- Docker 不可用时停止，不以回调模拟通过。

## 3. The workflow

1. 阅读第 2 部分，并重述：独立门禁必须亲自重跑。
2. 写伪造回调不能放行的失败测试。
3. 在离线容器执行冻结副本的测试命令。
4. 执行固定权限反例并收集最小结果。
5. 运行 focused tests 和类型检查。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 伪造成功回调 | 不影响容器结果 | `verifyFrozenCandidate()` |
| 2 | 失败测试 | 拒绝 | 容器运行器 |
| 3 | 权限反例失败 | 拒绝 | 容器运行器 |
| 4 | 通过候选 | 返回绑定报告 | 独立门禁 |

