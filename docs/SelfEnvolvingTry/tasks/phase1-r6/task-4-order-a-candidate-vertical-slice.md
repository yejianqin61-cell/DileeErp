# 任务 4：验证订单 A 候选纵切

## 1. 任务位置

- 属于阶段一 `R-6 真实工具与独立门禁`，目标是证明订单 A 产量候选能被独立门禁复核。
- 本任务把脱敏样例、候选工具、容器测试、manifest 和门禁报告串成可重复纵切。
- 开始条件是任务 1 至任务 3 已完成；生产注册和热重载留给后续阶段。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/linux-isolation-probe.ts` — 真实 Linux 容器探针怎样启动。
- `apps/coding-worker/src/restricted-data-gateway.ts` — 受限数据协议怎样拒绝越界。
- `apps/coding-worker/src/candidate-gate.ts` — 门禁怎样复算候选证据。
- `apps/coding-worker/test/policy-adversarial.integration.test.ts` — 本地可重复对抗纵切怎样组织。

**已定**

- 使用固定脱敏样例，不连接生产数据库或外部模型。
- 必须同时证明正确每日/累计结果、越订单、降档、写操作、超限和哈希失配。
- 门禁通过只产生候选报告，不等于生产发布批准或活动工具可调用。

**边缘与接缝**

- 接触 R-6 纵切测试、固定脱敏样例和门禁报告生成。
- 接缝是候选包到 ERP 门禁结果；不改活动 Registry、热重载或 Query Agent 状态。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- order-a-candidate`
- `npm run test --workspace=@dilee/coding-worker && npm run typecheck --workspace=@dilee/coding-worker && npm run typecheck --workspace=@dilee/api && npm run harness:config --workspace=@dilee/coding-worker`

**未知项**

- 若任一权限反例无法在 Host 门禁复现，停止并让候选保持拒绝，不以 Builder 报告替代。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为合法样例和独立门禁批准写集成红测试。
3. 在隔离 Linux 容器运行候选工具和候选自测。
4. 由独立门禁复算哈希、重跑测试并产生报告。
5. 注入越订单、降档、写操作、超限和篡改反例。
6. 运行 Worker 全量测试、两侧类型检查和 Harness 配置装载。
7. 提交测试，再提交实现或夹具修正。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 员工甲 12+8，员工乙 5 | 每日与累计值符合样例 | Linux 候选运行 |
| 2 | 合法 manifest 和测试 | 独立门禁通过 | 候选门禁 |
| 3 | 申请读取订单 B | 失败且无跨单数据 | 受限入口 |
| 4 | 候选尝试写数据库 | 写操作拒绝 | Linux 容器 |
| 5 | 篡改候选文件后复验 | 哈希不匹配并拒绝 | 候选门禁 |

