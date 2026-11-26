# 任务 4：冷启动先出缓存再对账

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**。
- **本任务推进 R-11**：再次打开页面先看到上次内容，服务端快照到了就覆盖。
- **开工前提**：任务 1、3 已提交。**后续**：任务 5。

## 2. 要知道的

**先读**

- `apps/web/app/agent/page.tsx`：挂载 effect、`hydrateSession`、`submit`、新建与切换会话。
- `apps/web/lib/agent-cache.ts`：任务 3 的函数。
- `apps/web/lib/session-context.tsx`：页面怎么拿当前用户。
- `apps/web/test/agent-chat-page.test.tsx` 开头：接口与流的替身写法。

**已定**

- 缓存只在 `useSessionProfile()` 非空且 `openAgentCacheStore()` 非空时启用；否则行为与现在完全一样。
- 读缓存与请求服务端**并行**；服务端先回来就丢弃缓存结果。缓存读取永远不得挡住服务端路径。
- 缓存轮次全部按历史轮渲染（`turnFromSnapshotRun`），不进 reducer，reducer 不改。
- 对账完成前：`submit` 直接返回，输入框照常可打字；给 `AgentComposer` 加 `sendDisabled`，只禁发送按钮。
  现有 `disabled` 会连输入框一起禁掉，不用它。
- 对账期间用户新建或切换会话：迟到的结果整个丢弃。
- 每次服务端快照到手就 `writeCachedSession`；服务端会话列表为空则清缓存、回欢迎页。

**边界与接缝**

- 只动顾问页、`agent-composer.tsx` 和新测试 `apps/web/test/agent-cache-page.test.tsx`。接缝：渲染页面，外包 `SessionContext.Provider`，
  `vi.mock("../lib/agent-cache-idb")` 返回内存存储。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/agent-cache-page.test.tsx`，然后全套与 `npm run typecheck`。

**可能卡住**

- 两份现有页面测试（不带 Provider）要改才能绿：说明缓存没关干净，停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1、2，红后绿。
3. 用例 3、4，红后绿。
4. 用例 5、6，红后绿。
5. 跑全套与类型检查。
6. 提交：`feat(agent): 顾问页先显示本地缓存，再用服务端快照对账`。

## 4. 用例

默认账号 `role_keys: ["qita"]`；缓存预置一条完成的 operational 轮次，答案「缓存答案」。

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 接口永不返回；输入「新问题」回车 | 见「缓存答案」；未调 POST；输入框仍是「新问题」 | 页面 |
| 2 | 接口返回同一会话，答案「服务端答案」 | 只见「服务端答案」；缓存里也变成它 | 页面 |
| 3 | 缓存的 `get` 永不返回，接口正常 | 见「服务端答案」 | 页面 |
| 4 | 服务端会话列表为空 | 见 `agent-welcome`；缓存键被删 | 页面 |
| 5 | 快照挂起时点「新建对话」，之后快照返回 | 仍是欢迎页 | 页面 |
| 6 | 缓存里换成 full 轮次，接口永不返回 | 页面上没有该答案 | 页面 |

</task-brief>
