# 任务 3：建立独立候选门禁

## 1. 任务位置

- 属于阶段一 `R-6 真实工具与独立门禁`，目标是候选只能凭可复算的产物证据通过。
- 本任务生成规范化 manifest 与文件哈希，并独立核验路径、源码基线、权限声明和测试报告。
- 开始条件是任务 2 的候选包已可运行；完整 Linux 纵切等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/source-view.ts` — 源码清单哈希如何绑定固定 Git revision。
- `apps/coding-worker/src/job-policy.ts` — 候选申请与 Builder 自述为什么不是发布批准。
- `apps/coding-worker/src/container-policy.ts` — 现有 Linux 测试边界怎样构造。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — R-6 的独立门禁验收是什么。

**已定**

- 门禁重新计算规范化文件清单和 SHA-256，不信任 Builder/Root 自报哈希。
- 只接受候选源码、manifest、测试和报告白名单；拒绝路径穿越、符号链接及依赖/安装脚本。
- 门禁重跑候选测试与权限反例；哈希、基线、测试或权限任一不符都拒绝。

**边缘与接缝**

- 接触 candidate manifest、独立 gate 和测试证据验证。
- 接缝是只读 `evaluateCandidate()`；不激活生产工具或写 Artifact Registry。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- candidate-gate`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若门禁必须执行不受信任的安装脚本才能跑测试，停止并拒绝该候选，不扩大容器网络或权限。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为候选哈希不匹配写红测试。
3. 实现规范化 manifest 与确定性文件 SHA-256。
4. 实现白名单路径、依赖声明和源码基线检查。
5. 在隔离 Linux 容器重跑候选测试及权限反例。
6. 运行目标测试和类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 未改动的完整候选包 | 通过并返回重算哈希 | `evaluateCandidate()` |
| 2 | 文件内容与 manifest 哈希不符 | `CANDIDATE_HASH_MISMATCH` | `evaluateCandidate()` |
| 3 | 候选新增 `.env` 或 SQL 文件 | `CANDIDATE_PATH_DENIED` | 文件清单 |
| 4 | 源码基线与申请不符 | `SOURCE_BASELINE_MISMATCH` | 基线核对 |
| 5 | 测试或权限反例失败 | `CANDIDATE_VALIDATION_FAILED` | 独立测试器 |

