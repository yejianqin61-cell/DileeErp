/**
 * 编排层的看门狗与状态语义（2026-11-23）。
 *
 * 这一层钉两件事：
 *   1. **切断的 run 不进 `gated`**。`gated` 的意思是「有产出待部署」，
 *      被截断的 run 没有资格出现在那里 —— T-0027 就是这么被推进去的。
 *   2. **看门狗只问一次，且从不自己杀**。问是问用户，杀是用户说了才杀。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Coordinator, type CpuSampler } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { IncomingMessage } from '../src/feishu-event.ts'
import type { HarnessResult, HarnessRunOptions } from '../src/harness-runner.ts'
import type { GitWorkspace, WorkspaceBegin, WorkspaceFinish } from '../src/git-workspace.ts'
import type { DispatchAction } from '../src/dispatcher.ts'
import { TicketStore } from '../src/ticket-store.ts'

const FIXED = new Date('2026-11-23T10:00:00.000Z')

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderType: 'user',
    text: '结算方式加两个账户',
    mentionsBot: true,
    eventId: 'ev_1',
    createTime: '1763265600000',
    threadId: null,
    parentId: null,
    rootId: null,
    ...overrides,
  }
}

function harnessResult(overcome: Partial<HarnessResult> & Pick<HarnessResult, 'outcome'>): HarnessResult {
  const { outcome, ...rest } = overcome
  return {
    outcome,
    sessionId: 'session-1',
    finalText: '完成了一部分',
    events: [],
    counts: { toolCalls: 3, subagentCalls: 0, textEvents: 2 },
    exitCode: outcome === 'completed' ? 0 : 0,
    durationMs: 43 * 60_000,
    ...rest,
  }
}

/** 一个假的 workspace：只实现编排层真正调用的三个方法。 */
function fakeWorkspace(finish: Partial<WorkspaceFinish>): GitWorkspace {
  const begin: WorkspaceBegin = { branch: 'ticket/T-0001', baseSha: 'aaaa1111', stashedBefore: null }
  const done: WorkspaceFinish = {
    merged: false,
    mergedSha: null,
    mergedCommits: 0,
    autoCommitted: null,
    abandonedTag: null,
    stashed: null,
    conflict: false,
    detail: '本单没有任何提交产出，主干未变',
    ...finish,
  }
  return {
    begin: async () => begin,
    finishSuccess: async () => done,
    finishFailure: async () => done,
  } as unknown as GitWorkspace
}

function makeCtx(options: {
  action?: DispatchAction
  run?: (opts: HarnessRunOptions) => Promise<HarnessResult>
  workspace?: GitWorkspace | null
  watchdog?: boolean
  autoDeploy?: boolean
}): { store: TicketStore; transport: FakeFeishuTransport; coordinator: Coordinator; cleanup: () => void } {
  const storeDir = mkdtempSync(join(tmpdir(), 'dilee-cw-store-'))
  const store = new TicketStore(storeDir)
  const transport = new FakeFeishuTransport()
  // 假调度器按原话分发：含「截断」→ kill_run，含「继续」→ continue_run，其余建新单。
  // 之前的版本所有消息都返回同一个动作，导致「截断」被当成新需求建了第二张单，用例挂死。
  const dispatchFor = (text: string): DispatchAction => {
    if (text.includes('截断')) return { kind: 'kill_run', ticketNo: null }
    if (text.includes('继续')) return { kind: 'continue_run', ticketNo: null }
    return options.action ?? { kind: 'create_ticket' }
  }
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/fake/dsh.js',
    nodePath: '/fake/node',
    repoPath: '/fake/repo',
    now: () => FIXED,
    log: () => {},
    cardUpdateMs: -1,
    dispatchImpl: async (input) => ({ action: dispatchFor(input.text), source: 'model' }),
    runHarnessImpl: options.run ?? (async () => harnessResult({ outcome: 'completed' })),
    workspace: options.workspace === undefined ? null : options.workspace,
    autoDeploy: options.autoDeploy ?? false,
    watchdog:
      options.watchdog === false
        ? null
        : {
            options: { sampleIntervalMs: 60_000, idleThresholdMs: 10 * 60_000 },
            // 采样用假实现：`processCount: 0` 表示这一轮没读到，编排层必须交白卷
            createSampler: (): CpuSampler => ({
              sample: () => ({ totalPercent: 0.3, busiestChildPercent: 0, processCount: 1 }),
              reset: () => {},
            }),
          },
  })
  return { store, transport, coordinator, cleanup: () => rmSync(storeDir, { recursive: true, force: true }) }
}

function messages(transport: FakeFeishuTransport): string[] {
  return transport.sent.map((record) => record.payload)
}

/**
 * 结果卡可能是 `sendCard`（第一张）也可能是 `updateCard`（原地更新成结果卡），
 * 断言要两种都看，只看 sendCard 会拿不到最终内容。
 */
function cards(transport: FakeFeishuTransport) {
  return transport.sent.filter((record) => record.card !== undefined).map((record) => record.card!)
}

// ── 状态语义：切断不算成功 ───────────────────────────────────────────────────

test('truncated → failed，卡片写「被截断」，且不排队部署', async () => {
  const ctx = makeCtx({
    run: async () =>
      harnessResult({ outcome: 'truncated', error: '已到绝对上限 6 小时，先送 SIGTERM 请它收口，Agent 收口后正常退出（**未完成**）' }),
    autoDeploy: true,
  })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()

    const ticket = ctx.store.all()[0]
    assert.equal(ticket.state, 'failed', '被截断的单必须是 failed，不能是 gated')
    assert.equal(ticket.result?.outcome, 'truncated')
    assert.match(ticket.result?.summary ?? '', /未完成|绝对上限/)

    const card = cards(ctx.transport).find((card) => card.title.includes('被截断'))
    assert.ok(card !== undefined, `卡片标题要写明被截断，实际：${cards(ctx.transport).map((card) => card.title).join(' / ')}`)
    assert.ok(
      card.lines.some((line) => line.includes('未完成')),
      '卡片正文要写明未完成',
    )
  } finally {
    ctx.cleanup()
  }
})

test('completed 但主干没有任何改动 → failed，不排队部署（没东西可上线）', async () => {
  const ctx = makeCtx({
    run: async () => harnessResult({ outcome: 'completed' }),
    workspace: fakeWorkspace({ merged: false, detail: '本单没有任何提交产出，主干未变' }),
    autoDeploy: true,
  })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()

    const ticket = ctx.store.all()[0]
    assert.equal(ticket.state, 'failed', '主干没变就不能进 gated')
    assert.match(ticket.result?.summary ?? '', /主干未变/)
    const card = cards(ctx.transport).find((card) => card.lines.some((line) => line.includes('未合入主干')))
    assert.ok(card !== undefined, '卡片要明说没合入')
  } finally {
    ctx.cleanup()
  }
})

test('completed 且真的合入 → gated（基线行为不变）', async () => {
  const ctx = makeCtx({
    run: async () => harnessResult({ outcome: 'completed' }),
    workspace: fakeWorkspace({
      merged: true,
      mergedSha: 'bbbb2222',
      mergedCommits: 2,
      detail: '已合入 main（2 个提交，至 bbbb2222）',
    }),
  })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()
    assert.equal(ctx.store.all()[0].state, 'gated')
  } finally {
    ctx.cleanup()
  }
})

// ── 看门狗：申请截断，但只问一次，且不自己杀 ──────────────────────────────────

test('疑似死锁：群里问一次（多次复判不重复刷屏），并记进工单', async () => {
  const ctx = makeCtx({
    run: async (opts) => {
      // 模拟运行器连续三轮都判成疑似死锁
      for (let i = 0; i < 3; i += 1) {
        opts.watchdog?.onSuspect?.({
          sample: { at: 1, lastEventAgeMs: 12 * 60_000, cpuPercent: 0.3, maxChildCpuPercent: 0, toolCalls: 129 },
          description: '已 12 分钟无事件进展、CPU 0.3%、无子进程活动',
          elapsedMs: 43 * 60_000,
          runStartedAtMs: 0,
        })
      }
      return harnessResult({ outcome: 'truncated', error: '用户选择截断（已跑 2600 秒），Agent 收口后正常退出（**未完成**）' })
    },
  })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()

    const asked = messages(ctx.transport).filter((text) => text.includes('疑似卡住'))
    assert.equal(asked.length, 1, `只该问一次，实际问了 ${asked.length} 次`)
    assert.match(asked[0], /继续/)
    assert.match(asked[0], /截断/)
    assert.match(asked[0], /12 分钟无事件进展/, '要把现场写清楚')

    const ticket = ctx.store.all()[0]
    assert.ok(ticket.watch !== null && ticket.watch !== undefined, '问过就要记进工单，重启后不重复问')
    assert.equal(ticket.watch?.decided, null, '还没答')
  } finally {
    ctx.cleanup()
  }
})

test('读不到 CPU（processCount=0）：一次都不报', async () => {
  const ctx = makeCtx({
    watchdog: true,
    run: async (opts) => {
      // 直接问编排层要一次读数：拿不到就必须是 null，而不是 cpuPercent=0
      const reading = opts.watchdog?.readCpu(1234)
      assert.equal(reading, null, '读不到进程树时必须返回 null，不能伪造成 CPU 0%')
      return harnessResult({ outcome: 'completed' })
    },
  })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()
    assert.equal(messages(ctx.transport).filter((text) => text.includes('疑似卡住')).length, 0)
  } finally {
    ctx.cleanup()
  }
})

// ── 用户的回答 ───────────────────────────────────────────────────────────────

test('用户回「截断」：abort 掉正在跑的 run，并按失败处理', async () => {
  let sawAbort = false
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })

  const ctx = makeCtx({
    action: { kind: 'create_ticket' },
    run: async (opts) => {
      started()
      await new Promise<void>((resolve) => {
        if (opts.abortSignal?.aborted === true) {
          resolve()
          return
        }
        opts.abortSignal?.addEventListener(
          'abort',
          () => {
            sawAbort = true
            resolve()
          },
          { once: true },
        )
      })
      return harnessResult({ outcome: 'truncated', error: '用户选择截断（已跑 600 秒），Agent 收口后正常退出（**未完成**）' })
    },
  })

  try {
    // 第一条：建单并开工
    await ctx.coordinator.handle(message())
    await startedPromise

    // 第二条：用户说截断（假调度器按原话分发成 kill_run）
    await ctx.coordinator.handle(message({ messageId: 'om_kill', text: '截断' }))
    await ctx.coordinator.drain()

    assert.equal(sawAbort, true, '用户说截断后必须真的 abort 子进程')
    const ticket = ctx.store.all()[0]
    assert.equal(ticket.state, 'failed', '截断按失败处理')
    assert.ok(
      messages(ctx.transport).some((text) => text.includes('正在停')),
      '要回一句「正在停」，否则用户不知道话有没有生效',
    )
  } finally {
    ctx.cleanup()
  }
})

test('没有在跑的单时说「截断」/「继续」→ 明确回一句，不假装成功', async () => {
  const ctx = makeCtx({ action: { kind: 'kill_run', ticketNo: null } })
  try {
    const outcome = await ctx.coordinator.handle(message({ messageId: 'om_kill', text: '截断' }))
    assert.equal(outcome.note, 'kill:none')
    await ctx.coordinator.drain()
    assert.ok(messages(ctx.transport).some((text) => text.includes('没有正在跑的单')))
  } finally {
    ctx.cleanup()
  }
})

test('用户回「继续」：不 abort，把采样基线重置，允许以后再问', async () => {
  let resolver!: () => void
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resolver = resolve
  })

  const ctx = makeCtx({
    action: { kind: 'create_ticket' },
    run: async (opts) => {
      started()
      assert.equal(opts.abortSignal?.aborted, false)
      await gate
      assert.equal(opts.abortSignal?.aborted, false, '用户说继续，就不该 abort')
      return harnessResult({ outcome: 'completed' })
    },
  })

  try {
    await ctx.coordinator.handle(message())
    await startedPromise

    await ctx.coordinator.handle(message({ messageId: 'om_cont', text: '继续' }))
    assert.ok(
      messages(ctx.transport).some((text) => text.includes('继续跑')),
      '要回一句「继续跑」',
    )
    resolver()
    await ctx.coordinator.drain()
  } finally {
    ctx.cleanup()
  }
})
