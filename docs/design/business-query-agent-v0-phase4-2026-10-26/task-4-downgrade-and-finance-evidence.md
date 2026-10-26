## 1. Where this task sits

- **Phase 4 财务档位完整查询**：降权后旧财务运行不能被读取、重放或再送入模型。
- **本任务推进 R-2 两档数据权限、R-12 数据口径与来源**：收口七项财务能力证据。
- **开始于** T1–T3 全部完成。**后续等待它**：Phase 5 恢复体验。

## 2. What the developer needs to know

**Read first**

- `context-manager.ts` — 旧 `full` 轮次进入历史的限制。
- `stream-transport.ts` — SSE 重放时的降权拒绝。
- `tools/tool-executor.ts` — 工具执行前的有效档位重查。
- `apps/web/lib/business-query-state.ts` — 前端接收终态事件的清理缝。
- `business-query-agent-v0-module-design-2026-10-25.md` — 降权验收条件。

**Settled**

- 降权后旧 `full` run 不能进 operational 历史，也不能 SSE 重放。
- 运行中下一次财务工具调用必须拒绝，不能写新的财务事件。
- 前端收到访问撤销时清除财务答案与来源片段。
- 所有 7 项财务 operation 仅 `full` 可执行。

**Edges and seam**

- 触及权限、SSE、前端 reducer 与 Phase 4 测试；不改角色管理。
- 缝是 `StreamTransport.follow()` 和前端 reducer 的 error 事件。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-finance-access.test.cjs`
- `npm run typecheck --workspace=@dilee/api && npm run test:unit --workspace=@dilee/web`

**Unknowns**

- 已发送到浏览器的内容无法撤回；只保证本地状态和后续重放清除。
- 若现有 reducer 没有撤销事件缝，停止并说明所需最小前端接口。

## 3. The workflow

1. 阅读第 2 部分并复述：降权必须堵住工具、历史、SSE 和页面状态。
2. 为七项财务 capability 的双角色矩阵写红测。
3. 为旧 full 历史与 SSE 重放拒绝写红测。
4. 为运行中降权后的工具拒绝写红测。
5. 为前端撤销事件清除财务片段写红测并实现。
6. 运行任务命令、真库双角色对照并提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 七项财务能力 + `operational` | 全部 403 | `ToolExecutor.execute()` |
| 2 | 七项财务能力 + `full` | 全部可执行 | capability matrix |
| 3 | 旧 full run 后降权 | 不进入八轮历史 | `history()` |
| 4 | 降权后重连 SSE | `ACCESS_REVOKED` 后关闭 | `follow()` |
| 5 | 前端撤销事件 | 清掉答案和来源 | reducer |
