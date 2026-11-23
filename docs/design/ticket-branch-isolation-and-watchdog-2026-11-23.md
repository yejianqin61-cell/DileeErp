# 工单分支隔离、失败抛弃与看门狗

日期：2026-11-23｜版本：1.0｜状态：**已设计，实施中**｜类型：设计

上游：[Agent 应用层架构](agent-application-layer-architecture-2026-11-14.md)、
[LLM 调度器与进度播报精简](llm-dispatcher-and-progress-notice-2026-11-20.md)。

## 0. 用户决定（2026-11-23 原话）

> 对，改代码的 ticketbot 就不并发了，服务器资源，串行，语义篡改都很麻烦。ticketbot 就并行排队好了。
> 然后我同意 ticketbot 这边，每个会话一个 git branch 或者 git worktree，完工后 merge，
> 并把线上版本给 push 到 github。以及，有的任务 45 分钟无法完工并不是死锁而是复杂度过高，
> 这个时候不应该强制截断。应当由一个心跳 agent standby，定期查看进程进度，如果疑似死锁，
> 向用户报告，申请截断。
> 如果 run 失败，本 git branch 的改动要抛弃，不允许 merge。这样可以保证工单开始时的代码整洁性。
> run 结束时若工作区仍脏，自动 stash 并写进工单结论（"残留已暂存为 stash@{n}"），而不是留在树里等下一个受害者。

拆成五条决定：

| # | 决定 | 影响面 |
|---|---|---|
| A | **保持不并发**：多张单可以同时被受理（并行排队），执行严格串行 | 不变 |
| B | **每会话一个分支**，完工后 merge 回 main | 新增工作区管理层 |
| C | **取消 45 分钟硬截断**，改心跳看门狗 + 向用户申请截断 | 重写超时语义 |
| D | **run 失败 → 抛弃该分支，不允许 merge** | 与 B 同一层 |
| E | **run 结束时工作区仍脏 → 自动 stash 并写进结论** | 与 B/D 同一层 |

## 1. 决定 A：仍然不并发（保持现状）

理由与现状一致，且用户已确认：2 vCPU / 1740 MB（可用约 870 MB），一次构建峰值即打满；
并行 run 会让 vitest 跑成一片超时假红；更关键的是**语义篡改** —— 两个 Agent 同时改同一批文件，
即使 git 不冲突，也可能互相推翻对方的意图，且难以审。

所以：**受理可以并行排队，执行永远串行**。这条不改。

## 2. 决定 B：分支隔离（选 git branch，不选 worktree）

### 2.1 为什么不是 worktree

用户给了「branch 或 worktree」两个选项。选 **branch**，理由是可验证的成本差：

| 维度 | branch-per-ticket | worktree-per-ticket |
|---|---|---|
| 额外磁盘 | 0 | 每个 worktree 要独立 `node_modules`（约 500 MB–2.3 GB） |
| 额外时间 | 0 | 每单 `npm ci` 约 2–3 分钟（占 run 预算） |
| 残留隔离 | 靠「开工前 clean + 收尾 stash」保证 | 天然隔离（独立目录） |
| 后续并行 | 仍需 worktree | 直接可用 |

因为**已经决定不并发**，worktree 唯一的优势（天然隔离）可以用「开工前清洁 + 收尾 stash」
以零成本换到；它的代价（每单多 2–3 分钟与上 GB 磁盘）在 40 GB / 2 核机器上是实付。故本轮用 branch。

若将来真要并行，再在 `git-workspace.ts` 内部换成 worktree，接口不变。

### 2.2 分支命名与基线

```
main        ← 始终是「已合入、可部署」的状态
 └─ ticket/T-0027   ← 每个工单一条，从当前 main 拉出
```

- 分支名：`ticket/<短号>`，短号带 `T-` 前缀，与工单一致，便于 `git branch | grep` 对照。
- 基线：**开工瞬间的 main HEAD**，记录进工单（`baseSha`），用于事后追溯「这单是从哪开始改的」。

### 2.3 生命周期

```
开工前
  git status --porcelain 必须为空
    └─ 不空 → git stash push -u -m "residue-before-T-00XX"（保现场，不丢）
  git checkout -b ticket/T-00XX main
        │
        ▼
   DSH 在 ticket/T-00XX 上改代码、commit
        │
   ┌────┴─────────────────────────┐
   ▼ run 成功                     ▼ run 失败 / 超时 / 用户批准截断
git checkout main              git stash push -u -m "T-00XX failed residue"
git merge --no-ff ticket/T-00XX   （先把未提交残留收进 stash）
git push origin main           git checkout main
（随后由 deploy 推 GitHub 并上线） git branch -D ticket/T-00XX
   │                              │
   ▼                              ▼
工单 gated（待部署）            工单 failed，分支已删除，改动丢弃
```

三条要点：

1. **merge 用 `--no-ff`**：保留「这一批改动来自 T-00XX」的边界，事后 `git log --graph`
   能看出每个工单的原子边界，而不是一堆平铺提交。这条与「历史必须是线性」并不冲突 ——
   `--no-ff` 产生的是可追溯的合并节点，不是随意分叉。
2. **merge 冲突不自动解**：冲突意味着两个工单改了同一处语义，自动合并等于让机器替人裁决生产代码。
   策略是 `merge --abort` → `checkout main` → 保留分支 → 工单回 `gated` 并在群里报
   「与 main 冲突，需人工决定」。**不 force push、不放弃对方改动**。
3. **成功 merge 之后才删除分支**；删除前先 push，保证本地与 GitHub 一致。

### 2.4 失败时「抛弃改动」与「stash 残留」的关系（容易读矛盾，先说清）

用户同一条消息里既说「失败要抛弃本分支的改动」，又说「工作区仍脏要自动 stash」。两者不矛盾：

| 对象 | 处置 | 目的 |
|---|---|---|
| **已 commit 到本分支的改动** | `git branch -D` 直接删除 | 保证 main 干净，失败的东西绝不进主干 |
| **未 commit 的残留（工作区脏）** | `git stash push -u` 收进 stash，记录 `stash@{n}` 到工单结论 | 保住「它到底改到哪一步」的现场，供人翻看 |

即：**主干不允许被污染，但现场不允许被销毁**。stash 是取证材料，不是候选代码。

### 2.5 启动时恢复（进程被强杀留下的中间态）

若机器人在 `ticket/T-00XX` 上被强杀，重启后工作区会停在工单分支上。启动时必做一次恢复：

```
当前分支 != main
  → git stash push -u -m "stale-<branch>-<ts>"
  → git checkout main
  → git branch -D <branch>   （该单必然没有正常收尾，视为失败）
  → 记日志 + 在该工单结论里写明「进程中断，残留已 stash」
```

这条对应 2026-11-21 的真实事故：三张失败单（T-0024/25/26）的 11 个文件、676 行改动
一直留在树里，导致后续**部署被预检自锁**，且下一张单会继承这批半成品（T-0019 → T-0020 已发生过一次）。

## 3. 决定 C：取消硬截断，改心跳看门狗

### 3.1 为什么不能一刀切 45 分钟

2026-11-21 的三张单（T-0024/25/26，同一需求「领料支持跨订单物料领用」）里两张是
`timeout`。它们不是死锁：Agent 一直在推进，只是这个需求本身大（跨订单库存、来源追溯、权限）。
**用固定时限切掉复杂度高的任务，等于系统性地只允许做简单需求。**

### 3.2 看门狗判据（死锁 vs 慢）

看门狗每 60 秒采一次样，只看三个可观测事实：

| 信号 | 采集方式 | 死锁特征 | 复杂度高特征 |
|---|---|---|---|
| 事件流推进 | `harness-runner` 的 `onEvent` 计数 | 长时间无新事件 | 有事件，但间隔长（一次构建/一次大文件读） |
| 进程是否在真正干活 | `/proc/<pid>/stat` 的 utime+stime 增量 | CPU 增量≈0 | CPU 有增量 |
| 子进程树 | `/proc` 扫描 `DILEE_RUN_ID` 标记 | 无活动子进程 | 有 tsc/next/vitest 在跑 |

**疑似死锁**判定（三者同时成立，连续 2 次采样）：
- 距最后一个事件 ≥ 10 分钟；
- 进程存活但 CPU 增量 < 1%（两次采样间）；
- 标记进程树里没有 CPU > 5% 的子孙。

**慢但活着**：有事件推进，或有 CPU 消耗 → 不报，继续等。

### 3.3 处置分级

```
疑似死锁（第一次）
  → 群里发一条：「T-0027 疑似卡住：已 18 分钟无进度、进程无 CPU 消耗。
                  回复『继续』让它再跑，回复『截断』我终止它。」
  → 工单进入 pending_kill 状态，记录 askedAt
  → 继续等，不自动杀

用户回「继续」        → 清除 pending，重置看门狗计时，继续跑
用户回「截断」        → SIGTERM → 等 60 秒 → SIGKILL（进程组 + 标记清理）
                       → 按失败路径收尾（stash 残留、删分支、工单 failed）

用户一直不回           → 每 30 分钟再提醒一次；不自动杀
```

### 3.4 但仍需要一条绝对上限

「不强制截断」不等于「允许无限跑」。绝对上限设 **6 小时**，理由是：三张超时单都在 45 分钟附近，
6 小时已经是一个复杂度极高需求的上限；超过它继续跑，更可能是真死循环或机器被拖死。

到达 6 小时时：**先发 SIGTERM 让 Agent 收口**（把「做到哪了」写进结论），60 秒后才 SIGKILL，
并在群里如实说明「已到绝对上限 6 小时，强制收口」。这不是 timeout 判定，是资源底线。

> 附带收益：服务器上现在运行的机器人已有一版「提前 120 秒 SIGTERM 收口」的 `graceMs` 逻辑
> （不在仓库里）。本轮把它正式收回仓库，语义并入上面的绝对上限，不再有 45 分钟硬杀。

### 3.5 为什么不让看门狗自己决定杀

看门狗只能看到「没动静」，看不到「它是不是正在算一个很难的东西」。杀掉一个正在推进的复杂任务，
成本是多花 45 分钟重跑；而放一个真死锁继续跑，成本是占住单车道（后面的单一起等）——
两者都不小，所以**决定权交给用户**，看门狗只负责「尽快让人知道」。

## 4. 决定 D：失败不 merge

已在 2.4 说明。补充一条硬规则：**`deploy` 只从 `main` 部署**。部署预检已有
「工作区干净」与「线上版本是 HEAD 祖先」两道门，本设计再加一道：

```
当前分支必须是 main，否则拒绝部署
```

防止「人还在工单分支上」时误部署出半成品。

## 5. 决定 E：残留自动 stash 并写进结论

run 结束（无论成败）时统一执行一次收尾：

```
if 工作区脏:
   ref = git stash push -u -m "<ticketNo>-<outcome>-<ts>"
   → 写进工单 result.notes: "残留已暂存为 <ref>（git stash list 可查看）"
   → 同时写进结果卡片
```

`-u` 必须带：未跟踪文件（新写的测试、新组件）正是最容易漏掉、又最容易污染下一单的东西。

## 6. 接口

### 6.1 新增 `src/git-workspace.ts`

```ts
export interface WorkspaceBegin { branch: string; baseSha: string; stashedBefore: string | null }
export interface WorkspaceFinish {
  merged: boolean          // 是否已合入 main
  mergedSha: string | null
  stashed: string | null   // 收尾 stash 的 ref
  conflict: boolean        // merge 冲突（未合并，分支保留）
  detail: string
}

export interface GitWorkspace {
  /** 开工：清洁检查 + 从 main 拉分支。 */
  begin(ticketNo: string): Promise<WorkspaceBegin>
  /** 成功收尾：checkout main → merge --no-ff → 返回合并结果。不 push（push 在 deploy 里）。 */
  finishSuccess(ticketNo: string): Promise<WorkspaceFinish>
  /** 失败收尾：stash 残留 → checkout main → 删分支。 */
  finishFailure(ticketNo: string): Promise<WorkspaceFinish>
  /** 启动恢复：把停在工单分支上的残留收走。 */
  recover(): Promise<{ recovered: string | null; stashed: string | null }>
  /** 当前分支，部署预检用。 */
  currentBranch(): Promise<string>
}
```

实现要求：所有 git 调用带 `cwd: repoPath`（历史上漏过一次）；失败不抛给调用方，返回
`detail` 让上层如实写进结论。

### 6.2 `TicketStore` 新增字段

```ts
branch?: string | null        // ticket/T-00XX
baseSha?: string | null       // 开工时的 main HEAD
stashRef?: string | null      // 残留 stash 的 ref
```

### 6.3 `Coordinator` 变化

- `runTicket` 用 `begin()` / `finishSuccess()` / `finishFailure()` 包住；
- 失败分支：**绝不 merge**，并删分支；
- 结果卡与工单结论带上 `branch` / `mergedSha` / `stashRef`；
- 启动时先 `recover()`。

### 6.4 看门狗（已实施，以下为实施后的真实签名）

> 本节初稿曾写 `WatchdogSample { lastEventAtMs; events; cpuTicks }`。实施时按「采样与判定分家」
> 拆成了两个模块，真实签名以 [`src/watchdog.ts`](../../tools/ticket-agent/src/watchdog.ts) 为准。

```ts
// src/watchdog.ts —— 纯判定，零副作用（不读时钟、不采样、不杀进程）
export type WatchVerdict = 'alive' | 'suspect' | 'ceiling'
export interface ProgressSample {
  at: number; lastEventAgeMs: number; cpuPercent: number
  maxChildCpuPercent: number; toolCalls: number
}
export function judge(
  samples: readonly ProgressSample[], nowMs: number, runStartedAtMs: number, opts?: WatchdogOptions,
): WatchVerdict
export function needCeilingWarning(nowMs: number, runStartedAtMs: number, opts?: WatchdogOptions): boolean
export function describeVerdict(verdict, samples, nowMs, runStartedAtMs, opts?): string   // 一句中文，群里用
```

```ts
// src/run-sampler.ts —— /proc 采样，复用 run-janitor 的进程发现（DILEE_RUN_ID 标记）
export class RunSampler {
  constructor(options: { runId: string; mainPid: number; procRoot?: string; clockSeconds?: number })
  sample(): { atMs: number; totalPercent: number; busiestChildPercent: number; processCount: number }
  reset(): void
}
```

两条实施中定下、原设计没写清的约定：

- **`processCount === 0` 表示「这一轮没观测到」，不是「CPU 0%」。** 上层必须跳过这一轮判定。
  用 `-1` 当未知尤其危险：判据是 `cpuPercent < 3`，`-1` 会直接满足「没在干活」，
  再凑上事件静止就是一次误报。
- **`busiestChildPercent` 按「逐 pid」算并排除主进程。** 一个 60% 的 tsc 和十个 6% 的进程
  聚合值相同，但「有没有子孙在真干活」只有单进程粒度能回答。

`coordinator` 侧：`ActiveRun` 持有 `AbortController`（用户截断走 `abortSignal`）、采样器、
以及「有没有问过」的记账；`TicketStore.watch` 落盘防重启后复读。`dispatcher` 新增
`kill_run(ticketNo?)` / `continue_run(ticketNo?)`，把用户的「截断 / 继续」翻译成动作。

## 7. 验收

| 项 | 判据 | 结果（2026-11-23） |
|---|---|---|
| 分支隔离 | 开工后 `git branch --show-current` = `ticket/T-00XX`；main 不动 | ✅ 上线后首次真机 run 已验证 |
| 成功合并 | 工单 gated 时 main 多一个 `--no-ff` 合并节点 | ✅ 但修了口径：零提交不 merge（见 §9.1） |
| 失败抛弃 | run 失败后该分支不存在，main 的 HEAD 与开工前一致 | ✅ 已提交的改动会打 `abandoned/*` tag 留证再删 |
| 残留 stash | 失败后 `git stash list` 多一条，工单结论写明 `stash@{n}` | ✅ |
| 启动恢复 | 重启后自动 stash + 回 main + 删分支 | ✅ |
| 部署闸门 | 在工单分支上执行部署被拒绝 | ✅ |
| 看门狗 | 单测覆盖三态；真机验证一次「发问 → 回继续」 | ✅ 单测 20 条；采样在真机探针验证（§9.3）；群里问答待用户回话时验证 |

## 8. 风险

| 风险 | 应对 |
|---|---|
| merge 冲突频繁 | `--no-ff` + 冲突即停；长期靠「一次只做一件事」的任务拆分减少重叠 |
| stash 越堆越多 | 结论里写明 ref；启动恢复只清工作区，不删旧 stash（取证材料不自动清理） |
| 分支泄漏（收尾失败） | `recover()` 每次启动清一遍；分支名可 grep 对照工单 |
| 6 小时上限仍可能误杀 | 到点前 30 分钟在群里预告，给用户提前叫停的机会 |
| 看门狗误报 | 只报不杀，误报成本 = 群里多一条消息 |
| 看门狗漏报（读不到 CPU） | `processCount === 0` 时跳过判定；宁可漏报不可误报 |
| 空转进程让地板失效 | 地板取 3% 而不是 1%（真机实测空转 node ≈1.6%，见 §9.3） |

## 9. 实施记录（2026-11-23 晚间）

### 9.1 T-0027：一次真实的「语义篡改」，改了三处口径

T-0027（结算方式加两个账户）跑满 43 分钟被软截止，随后被标成 `gated`（可部署）。
查下来是三层口径同时错了：

1. **切断被当成完成。** `harness-runner` 里「收到 SIGTERM 后退出码 0 → `completed`」。
   退出得干净只说明它来得及写交接，不说明任务做完了。改为 `truncated`，并用纯函数
   `outcomeForStop` 固化这条规则（跨平台可断言）。
2. **空合并被当成「已合入主干」。** 分支还停在基线时 `git merge --no-ff` 只回
   `Already up to date`，旧代码据此报 `merged: true` / 「已合入主干」。而真相是主干
   一个字节没变，43 分钟的产出全在一个 stash 里。改为：零提交不调 merge、
   `merged` 只在 HEAD 真的前进时为 true，卡片另起一句「未合入主干」。
3. **成功收尾先把产出 stash 掉再合并。** 顺序反了：工单成功的定义是「需求已实现」，
   此时工作区里的改动**就是**产出。改为先在工单分支上自动提交，再 `--no-ff` 合入。

配套改的还有：状态映射从「`outcome === 'completed'` → gated」改成
「`completed` **且主干真的进了改动** → gated」，否则 failed。没有产出就不该可部署。

### 9.2 续跑（本次新增，原设计没有）

既然允许跑很久，就得允许「接着上次的现场跑」，否则每次截断都从零开始，
复杂度高的需求永远做不完。`begin(no, { resume: true })` 保留同名工单分支与它上面的提交、
切过去接着干；`TicketStore.resume` 是一次性开关，跑完自动清。

T-0027 的抢救实证了这条的价值：它的 9 个文件（4 个改动 + 5 个新增，含设计文档、
页面、组件、lib、测试）被恢复成 `ce75b2e0` 提交留在 `ticket/T-0027` 上，
不必重跑那 43 分钟。

> 记一笔自己的误判：起初只看 `git stash show --stat`（只列已跟踪文件），
> 得出「网页那半没做」的结论，实际未跟踪的 5 个文件才是主体。
> 看 stash 内容必须 `stash show --include-untracked` 或直接 `stash branch` 展开。

### 9.3 真机探针：/proc 到底读不读得到（`scripts/probe-sampler.ts`）

看门狗的全部输入来自进程树 CPU。读不到的话它永远不报，而且安静得让人以为一切正常。
在 2 vCPU 服务器上实测三组：

| 场景 | 稳定读数 | 结论 |
|---|---|---|
| 父进程自己烧 CPU | total=99.8% | 总百分比可信 |
| 父闲子忙（真 fork，`& wait`） | total=99.6%，**busiestChild=99.6%**，n=2 | 第三条判据有效 |
| 父子都闲 | total 在 **1.6%** 与 0.0% 之间抖动 | 1% 地板会让死锁帧判成「还在干活」 |

由此把 `cpuFloorPercent` 从 1 改成 3。漏报等于没上线，这个参数不能贴着噪声取。

两个踩坑记在这里：`bash -c '单条命令'` 会被 bash **exec** 掉，父子合成一个进程，
探针第一版因此测不出 `busiestChild`（必须 `& wait`）；本窗口才出现的子进程没有基线、
当帧不给百分比，所以要看第二帧以后。
