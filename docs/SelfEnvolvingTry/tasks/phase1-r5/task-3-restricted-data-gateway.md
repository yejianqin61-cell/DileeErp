# 任务 3：建立受限只读数据入口

## 1. 任务位置

- 属于阶段一 `R-5 源码与数据只读隔离`，目标是生成工具不能取得 Prisma 或原始 SQL 通道。
- 本任务建立宿主侧结构化请求门禁，按订单、工序、档位和行数投影包装产量数据。
- 开始条件是 R-4 的能力状态机已完成；订单 A 真实工具和 ERP 门禁等待 R-6。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/business-query-agent/tools/tool-executor.ts` — 现有执行器的重查、投影和限量顺序。
- `apps/api/src/modules/business-query-agent/tools/query-fact.ts` — 结果与来源为什么不能是 Prisma 原对象。
- `apps/api/src/modules/business-query-agent/tools/production-query-tools.ts` — 包装工序日报的现有字段形状。
- `docs/SelfEnvolvingTry/business-query-agent-generated-tools-architecture-2026-10-29.md` — 生成工具的数据边界。

**已定**

- 生成工具只能提交固定 operation 的 JSON 请求；未知字段、未知 operation 和无效范围失败关闭。
- 数据适配器留在宿主侧；候选代码只得到 `read(request)`，得不到 Prisma client、SQL 或连接串。
- 宿主再次核对返回行属于请求订单与工序，并投影固定字段、来源和最大行数。

**边缘与接缝**

- 接触 Coding Worker 的受限数据协议、宿主门禁和单元测试。
- 接缝是 `RestrictedDataGateway.read()`；不连接真实数据库，也不组装最终 `QueryFact`。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- restricted-data-gateway`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若真实包装产量需要当前固定投影之外的字段，R-6 先确认最小字段，不在本任务开放任意查询。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为未知 operation 和额外 SQL 字段写红测试。
3. 实现固定 operation 的严格请求解析和宿主适配器调用。
4. 加入跨订单、跨工序返回行的失败关闭校验。
5. 加入固定投影、来源、排序和行数上限。
6. 运行目标测试和类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 未知 operation | `DATA_OPERATION_DENIED` | `read()` |
| 2 | 请求携带 `sql` | `DATA_REQUEST_INVALID` | 请求解析 |
| 3 | 适配器返回订单 B 行 | `DATA_SCOPE_VIOLATION` | 返回门禁 |
| 4 | 适配器返回其他工序行 | `DATA_SCOPE_VIOLATION` | 返回门禁 |
| 5 | 合法包装产量行 | 固定投影、来源和限量 | `read()` |

