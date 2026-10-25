# T-5 查询页与前端状态机

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路的用户界面。
- 本任务落 R-10 查询页状态机：reducer、SSE 读取器、页面、四处栏目接线。
- 前置：T-4 的 6 条路由可用。无后续任务依赖它（T-6 走 HTTP 层）。

## 2. 开发者须知

**先读**

- `apps/web/lib/surface-permission.ts` 与其后端对偶 `apps/api/src/platform/authorization/surface-scope.ts` — 栏目清单要两边同改（测试注释里写明「两边一起改」）。
- `apps/web/components/layout/app-shell.tsx` 的 `navigation` 数组 — 菜单入口落点。
- `apps/web/lib/surface-permission.test.mjs` — lib 层 node:test 直测 `.ts` 的既有模式。
- `apps/web/lib/api-client.ts` — 请求与错误处理的既有风格。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「SSE 与前后端状态机」— 前端状态图与快照恢复规则。

**定案（不得重开）**

- 前端状态：`idle → submitting → connecting → streaming → done`，另有 `disconnected`、`error`、`cancelled`；`disconnected` 可回 `connecting/streaming/done/error/cancelled`。
- reducer 只按合法迁移更新；按 `seq` 去重；刷新后以后端快照重建，续接从最后**已应用**的 seq 开始。
- SSE 用 fetch 流式读取（不用 EventSource）：便于带 Last-Event-ID 头与统一错误处理。
- 栏目 key `business-query`，标签「业务查询」，路径 `/business-query`；四类表面角色都能进入（`hr` 范围显式加入，同 `account` 的处理）。
- 快照恢复读 GET `/business-query/sessions/:id`：答案从已持久化片段重建，不得与重放的 `answer_delta` 重复拼接。

**边界**

- 新文件：`apps/web/lib/business-query-state.ts`、`apps/web/lib/business-query-stream.ts`、`apps/web/app/business-query/page.tsx`、`apps/web/lib/business-query-state.test.mjs`。
- 改四处：后端与前端栏目清单、`app-shell.tsx` 导航数组。不动后端 API。

**运行**

- `node --test "apps/web/lib/business-query-state.test.mjs"`
- `npm run typecheck --workspace=@dilee/web`

**未知**

- 页面不引新依赖（不用 react-markdown）；答案按纯文本分段渲染。若布局组件不够用，先复用 `components/ui` 现成件。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写 `business-query-state.ts`：初始 state 与 reducer；先写测试（红）。
3. 写 `business-query-stream.ts`：fetch 读流、解析 `id:`/`data:`/注释心跳、断线重连带 Last-Event-ID。
4. 写 `app/business-query/page.tsx`：提问、进度、答案、来源、取消、错误与重试；挂载时恢复最近会话快照。
5. 接线四处栏目（后端 surface-scope、前端 surface-permission、app-shell 导航），跑两边的栏目测试确认不破。
6. 跑本任务两条命令，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | `idle` 收 `RUN_CREATED` | 状态 `connecting`，记录 run_id | reducer |
| 2 | `streaming` 收 seq=3 后又收 seq=3 | 状态不变，内容不重复拼接 | reducer |
| 3 | `streaming` 收两个 `answer_delta` | 答案按顺序拼接 | reducer |
| 4 | `streaming` 收 `completed` | 状态 `done`，来源与用量落定；再收事件被忽略 | reducer |
| 5 | `streaming` 断线 | `disconnected`；恢复时先套快照再续接，不重复拼接 | reducer |
| 6 | 收 `error` 事件 | 状态 `error`，保留已收片段并标记未完成 | reducer |
| 7 | `canVisitPath(["renshi"...对准 hr 范围], "/business-query")` | 允许进入 | `canVisitPath` |
