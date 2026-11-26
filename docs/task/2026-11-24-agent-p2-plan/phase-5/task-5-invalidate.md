# 任务 5：失败、撤权、退出与回填

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**。
- **本任务收尾 R-11**：缓存什么时候该留、什么时候必须清、什么时候更新。
- **开工前提**：任务 4 已提交。**后续**：任务 6。

## 2. 要知道的

**先读**

- `apps/web/app/agent/page.tsx`：挂载的错误分支与 `followStream` 的 catch。
- `apps/web/lib/api-client.ts`：`apiGet` 在哪些情况抛什么。
- `apps/web/lib/business-query-stream.ts`：被拒与断线分别怎么抛。
- `apps/web/components/layout/app-shell.tsx`：`logout`。

**已定**

- 已显示缓存时对账失败：错误**不是** `ApiClientError`，或 `code === "REQUEST_ERROR"`，才保留缓存内容，
  提示「无法连接业务查询服务，当前显示本地缓存」，重试动作是刷新页面，发送仍禁用。
- 其他任何错误码：清缓存、清掉屏上内容，走现在的 `ErrorState`。
- reducer 进入 `ACCESS_REVOKED`，或流以 `SSE_REFUSED_*` 被拒：清缓存。
- 活动轮次到达终态且缓存启用：静默再拉一次该会话快照，**只写缓存，不动界面**；拉取失败忽略。
- 退出登录：先 `store.clear()`（抛错忽略），再走现有流程。

**边界与接缝**

- 动顾问页与 `app-shell.tsx`。接缝：任务 4 的页面测试与 `app-shell.test.tsx`。

**运行**

- `npm run test:unit --workspace=@dilee/web`，然后 `npm run typecheck`。

**可能卡住**

- `followRunStream` 拒绝时只抛中文文案，页面分不出「被拒」与「断线」。可以给错误加可判别标记，文案不变；
  要改文案才做得到就停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1、2，红后绿。
3. 用例 3、4，红后绿。
4. 用例 5，红后绿。
5. 跑全套与类型检查。
6. 提交：`feat(agent): 撤权与退出清空顾问缓存，轮次结束后回填`。

## 4. 用例

起点同任务 4：账号 `qita`，缓存里一条「缓存答案」。

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 接口抛 `TypeError("fetch failed")`；另一次抛 `REQUEST_ERROR` | 「缓存答案」仍在，`agent-notice` 含上述提示；缓存键还在 | 页面 |
| 2 | 接口抛 `AGENT_ACCESS_DENIED` | 页面无「缓存答案」；缓存键被删 | 页面 |
| 3 | 进行中轮次收到 `seq: 0`、`code: "ACCESS_REVOKED"` 的错误事件 | 缓存键被删 | 页面 |
| 4 | 提问后流推 `completed`，补拉的快照含新轮次 | 缓存含新轮次；屏上内容不因补拉改变；POST 次数不增加 | 页面 |
| 5 | 点 `logout-button` | 存储 `clear` 调一次，且仍请求 `/auth/logout` | AppShell |

</task-brief>
