# 任务 3：缓存读写与档位拦截

<task-brief>

## 1. 在哪里

- **阶段 5 顾问换外壳**。
- **本任务推进 R-11**：一个模块决定什么能落盘、什么能读出来。页面此时还不用它。
- **开工前提**：无。**后续**：任务 4、5。

## 2. 要知道的

**先读**

- `apps/web/lib/agent-chat.ts`：`AgentSnapshotRun` 的字段与终态判断。
- `apps/api/src/modules/business-query-agent/access-level.ts`：角色到数据档位的规则（照抄，不 import）。
- `apps/web/lib/session.ts`：`SessionProfile.role_keys`。

**已定**（理由见本批 README）

- `agent-cache.ts` 导出 `type CacheStore = { get(key), set(key, value), delete(key), clear() }`（全返回 Promise）、
  `cacheAccessLevel(roleKeys)`、`writeCachedSession(store, userId, sessionId, runs)`、
  `readCachedSession(store, userId, level)`（返回 `{ session_id, runs }` 或 `null`）、`clearCachedSession(store, userId)`。
- 键 `session:<userId>`，值 `{ v: 1, session_id, runs }`。写：只留 `access_level === "operational"` 且终态的轮次，一轮不剩就删键。
- 读：形状不对则删键返回 `null`；`level` 非 `full` 时滤掉非 `operational` 轮次，滤空返回 `null`。
  存储抛错时三个函数都不外抛。
- `cacheAccessLevel`：含 `laoban` 或 `caiwu` 为 `full`，其余（含空数组）为 `operational`。
- `agent-cache-idb.ts` 导出 `openAgentCacheStore(): CacheStore | null`：库 `dilee-agent-cache` v1、对象仓 `kv`；
  无 `indexedDB` 返回 `null`；打开失败后允许下次重试。

**边界与接缝**

- 只新增 `apps/web/lib/` 下两个模块与 `agent-cache.test.mjs`。接缝：上述函数，用内存 `Map` 作假存储。

**运行**

- `node --test apps/web/lib/agent-cache.test.mjs`，然后 `npm run test:unit --workspace=@dilee/web`、`npm run typecheck`。

**可能卡住**

- node 跑测试时 `agent-cache.ts` 对 `agent-chat` 只能 `import type`；终态判断在本模块内写。
- IndexedDB 适配器不写单测（不引假库），由任务 6 覆盖；不要为它加依赖。

## 3. 步骤

1. 读上面三个文件，用一行复述任务。
2. 用例 1–3（写与读），红后绿。
3. 用例 4–6（档位与损坏），红后绿。
4. 写 IndexedDB 适配器与用例 7。
5. 跑全套与类型检查，提交：`feat(agent): 顾问本地缓存读写，财务档轮次不落盘`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 用户 A 写两条 operational 完成轮次，按 A 读 | 同样两条与会话号 | 读写函数 |
| 2 | 接上，按用户 B 读 | `null` | 读函数 |
| 3 | 写 completed、responding、full、`access_level:"x"` 各一条；另一次只写后三条 | 前者只读回 completed 那条；后者键不存在 | 读写函数 |
| 4 | 手工塞入一条 operational、一条 full，分别按两个档位读 | `operational` 只得一条；`full` 得两条 | 读函数 |
| 5 | 键里放 `"乱码"`、`{ v: 2 }`、缺 `run_id` 的轮次 | 都返回 `null` 且键被删 | 读函数 |
| 6 | `get`、`set`、`delete` 全抛错 | 三个函数都正常返回，读为 `null` | 读写函数 |
| 7 | node 里调 `openAgentCacheStore()`；`cacheAccessLevel` 传 `["caiwu"]`、`["administrator"]`、`[]` | `null`；`full`、`operational`、`operational` | 导出函数 |

</task-brief>
