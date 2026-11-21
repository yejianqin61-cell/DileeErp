import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Coordinator } from '../src/coordinator.ts'
import { FALLBACK_REPLY, type DispatchAction, type DispatchInput, type DispatchOptions, type DispatchResult } from '../src/dispatcher.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { IncomingMessage } from '../src/feishu-event.ts'
import type { HarnessEvent, HarnessResult } from '../src/harness-runner.ts'
import { TicketStore } from '../src/ticket-store.ts'

const FIXED = new Date('2026-11-16T04:00:00.000Z')

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderType: 'user',
    text: '采购单列表页的搜索框，希望能按供应商名称搜',
    mentionsBot: true,
    eventId: 'ev_1',
    createTime: '1763265600000',
    threadId: null,
    parentId: null,
    rootId: null,
    ...overrides,
  }
}

function harnessOk(sessionId = 'session-1', finalText = '已修复：搜索框现在支持供应商名称。'): HarnessResult {
  return {
    outcome: 'completed',
    sessionId,
    finalText,
    events: [],
    counts: { toolCalls: 5, subagentCalls: 1, textEvents: 3 },
    exitCode: 0,
    durationMs: 120_000,
  }
}

/** 假调度器：按原话匹配返回预设动作，模拟「模型会选什么」。 */
type FakeDispatch = (input: DispatchInput, options: DispatchOptions) => Promise<DispatchResult>

function fakeDispatch(action: DispatchAction | ((input: DispatchInput) => DispatchAction)): FakeDispatch {
  return async (input) => ({
    action: typeof action === 'function' ? action(input) : action,
    source: 'model',
  })
}

interface SetupOptions {
  dispatch?: DispatchAction | ((input: DispatchInput) => DispatchAction)
  runner?: (input: { onEvent?: (event: HarnessEvent) => void; sessionId?: string }) => Promise<HarnessResult>
  cardUpdateMs?: number
  clock?: { ms: number }
}

function setup(options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-dispatch-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  const logs: string[] = []
  const prompts: string[] = []
  const runnerCalls: Array<{ sessionId?: string }> = []
  const dispatchInputs: DispatchInput[] = []
  const clock = options.clock ?? { ms: FIXED.getTime() }

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/fake/dsh.js',
    nodePath: '/fake/node',
    repoPath: '/fake/repo',
    now: () => new Date(clock.ms),
    log: (line) => logs.push(line),
    runHarnessImpl: async (input) => {
      prompts.push(input.prompt)
      runnerCalls.push({ sessionId: input.sessionId })
      if (options.runner !== undefined) {
        return await options.runner({ onEvent: input.onEvent, sessionId: input.sessionId })
      }
      return harnessOk()
    },
    dispatchImpl:
      options.dispatch === undefined
        ? async () => ({ action: { kind: 'reply', text: FALLBACK_REPLY }, source: 'fallback', error: 'test-default' })
        : fakeDispatch(options.dispatch),
    progressNoticeMs: 0,
    cardUpdateMs: options.cardUpdateMs ?? -1,
  })

  return {
    dir,
    store,
    transport,
    logs,
    prompts,
    runnerCalls,
    dispatchInputs,
    clock,
    coordinator,
  }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('问进度：不建单，用本地事实回答', async () => {
  const { dir, store, transport, coordinator } = setup({
    dispatch: (input) => {
      const hit = /T-\d{3,4}/.exec(input.text)
      return { kind: 'status', ticketNo: hit?.[0] ?? null }
    },
  })
  try {
    const created = store.create({ messageId: 'om_old', chatId: 'oc_1', text: '物料下拉打不开', at: 'x', state: 'queued' })
    store.setState(created.id, 'building', 'x')
    store.setProgress(
      created.id,
      {
        phase: 'editing',
        startedAt: new Date(FIXED.getTime() - 392_000).toISOString(),
        updatedAt: new Date(FIXED.getTime() - 1000).toISOString(),
        toolCalls: 23,
        subagentCalls: 1,
        filesChanged: 3,
        lastAction: 'edit apps/web/a.tsx',
        lastText: null,
      },
      'x',
    )
    const before = store.all().length

    const outcome = await coordinator.handle(message({ text: `汇报${created.no}进度` }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all().length, before, '问进度不应消耗工单号')
    const reply = transport.ofKind('reply').at(-1)
    assert.match(reply?.payload ?? '', /施工中，已用 6 分 32 秒/)
    assert.match(reply?.payload ?? '', /工具调用 23 次/)
    assert.equal(transport.ofKind('card').length, 0)
  } finally {
    cleanup(dir)
  }
})

test('回复卡片问进度：只回答，不当成追加需求', async () => {
  const { dir, store, transport, coordinator } = setup({
    // 模型会看上下文：回复卡片问的进度，它选 status 而不是追加
    dispatch: (input) =>
      input.replyingToTicketNo !== null
        ? { kind: 'status', ticketNo: input.replyingToTicketNo }
        : { kind: 'create_ticket' },
  })
  try {
    await coordinator.handle(message({ messageId: 'om_a' }))
    await coordinator.drain()
    const ticket = store.all()[0]

    const outcome = await coordinator.handle(
      message({ messageId: 'om_b', text: `${ticket.no} 进度`, parentId: 'om_fake_card_1' }),
    )
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all()[0].turns.length, 1, '不应累积成第二轮')
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /已完成，产出待部署/)
  } finally {
    cleanup(dir)
  }
})

test('硬规则纠偏：模型对卡片回复选建新单，被改成追加', async () => {
  const { dir, store, transport, coordinator } = setup({
    dispatch: { kind: 'create_ticket', hint: { module: 'sales', expected: '按单号搜', entry: null } },
  })
  try {
    await coordinator.handle(message({ messageId: 'om_a', text: '销售单按单号搜' }))
    await coordinator.drain()
    // 主卡片真正发出的 message_id 才是「回复卡片」的锚点
    const cardId = transport.ofKind('card')[0].messageId
    assert.ok(cardId !== undefined, '主卡片要有 message_id')

    // 用户回复卡片提「还要支持按物料搜」；模型没认出上下文，给了 create_ticket
    const outcome = await coordinator.handle(
      message({ messageId: 'om_b', text: '还要支持按物料编码搜', parentId: cardId }),
    )
    await coordinator.drain()

    assert.equal(outcome.outcome, 'appended')
    const tickets = store.all()
    assert.equal(tickets.length, 1, '不应新建工单')
    assert.equal(tickets[0].turns.length, 2)
    assert.equal(tickets[0].turns[1].hint?.expected, '按单号搜', '纠偏后提示字段保留')
    assert.ok(
      transport.sent.some((record) => record.kind === 'reply' && record.payload.includes('追加')),
      '要回复追加确认',
    )
  } finally {
    cleanup(dir)
  }
})

test('提问：reply 动作直接回话，不建单、不跑 DSH', async () => {
  const { dir, store, transport, runnerCalls, coordinator } = setup({
    dispatch: { kind: 'reply', text: '在销售单列表右上角点「导出」。' },
  })
  try {
    const outcome = await coordinator.handle(message({ text: '怎么导出销售单' }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all().length, 0, '提问不建单')
    assert.equal(runnerCalls.length, 0, '提问不占改代码车道')
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /右上角点「导出」/)
  } finally {
    cleanup(dir)
  }
})

test('模型不可用：只回兜底话术，不建单不开工', async () => {
  const { dir, store, transport, runnerCalls, coordinator } = setup({ dispatch: undefined })
  try {
    const outcome = await coordinator.handle(message())
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all().length, 0, '兜底不建单')
    assert.equal(runnerCalls.length, 0, '兜底不开工')
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /处理出错/)
  } finally {
    cleanup(dir)
  }
})

test('含糊需求：ask_more_info 留一张 needs_info 工单并追问', async () => {
  const { dir, store, transport, coordinator } = setup({
    dispatch: { kind: 'ask_more_info', question: '你希望它变成什么样？例如：应该按单号倒序。', ticketNo: null },
  })
  try {
    const outcome = await coordinator.handle(message({ text: '这个不对' }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'needs-info')
    const tickets = store.all()
    assert.equal(tickets.length, 1, '追问要留工单，补充的消息才有地方接')
    assert.equal(tickets[0].state, 'needs_info')
    const reply = transport.ofKind('reply').at(-1)?.payload ?? ''
    assert.match(reply, /你希望它变成什么样/)
    assert.equal(transport.ofKind('card').length, 0, '没开工不发主卡')
  } finally {
    cleanup(dir)
  }
})

test('start_run：failed 工单重新排队', async () => {
  const { dir, store, transport, runnerCalls, coordinator } = setup({
    dispatch: (input) => {
      const hit = /T-\d{3,4}/.exec(input.text)
      return { kind: 'start_run', ticketNo: hit?.[0] ?? 'T-0001' }
    },
  })
  try {
    const ticket = store.create({ messageId: 'om_old', chatId: 'oc_1', text: '第一次跑挂了', at: 'x', state: 'failed' })
    store.bindCard(ticket.id, 'om_fake_card_1', 'x')

    const outcome = await coordinator.handle(message({ text: `重新跑一下 ${ticket.no}` }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'ran')
    assert.equal(store.all()[0].state, 'gated', '重跑完成回到 gated')
    assert.equal(runnerCalls.length, 1)
    assert.ok(transport.sent.some((record) => record.kind === 'reply' && record.payload.includes('重新排队')))
  } finally {
    cleanup(dir)
  }
})

test('start_run：done 工单不重跑，说明原因', async () => {
  const { dir, store, transport, runnerCalls, coordinator } = setup({
    dispatch: (input) => {
      const hit = /T-\d{3,4}/.exec(input.text)
      return { kind: 'start_run', ticketNo: hit?.[0] ?? 'T-0001' }
    },
  })
  try {
    store.create({ messageId: 'om_old', chatId: 'oc_1', text: '已上线', at: 'x', state: 'done' })

    const outcome = await coordinator.handle(message({ text: '重跑 T-0001' }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all()[0].state, 'done', 'done 不能被重跑改写')
    assert.equal(runnerCalls.length, 0)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /已上线/)
  } finally {
    cleanup(dir)
  }
})

test('「部署」：deploy 动作触发部署，不建单', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-deploy-cmd-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  const deployCalls: unknown[] = []
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/x',
    nodePath: '/x',
    repoPath: '/x',
    now: () => FIXED,
    log: () => {},
    dispatchImpl: async () => ({ action: { kind: 'deploy' }, source: 'model' }),
    runHarnessImpl: async () => harnessOk(),
    progressNoticeMs: 0,
    cardUpdateMs: -1,
    deployConfig: {
      repoPath: '/opt/dilee/agent/repo',
      rootDir: '/opt/dilee',
      appDir: '/opt/dilee/app',
      workDir: '/tmp/dilee-deploy',
      archivePath: '/tmp/dilee-agent-release.tar.gz',
      recordsDir: '/opt/dilee/deploys',
      gitRemote: 'origin',
      gitBranch: 'main',
      keepBackups: 3,
      requirePush: true,
      skipTests: false,
      minFreeGb: 5,
      timeouts: {
        gitMs: 120_000,
        packMs: 180_000,
        buildMs: 2_400_000,
        testMs: 1_800_000,
        migrateMs: 300_000,
        switchMs: 600_000,
        verifyMs: 180_000,
        edgeMs: 360_000,
        rollbackMs: 360_000,
      },
    },
    deployImpl: async (input) => {
      deployCalls.push(input)
      return {
        ok: true,
        pushed: true,
        rolledBack: false,
        release: 'c'.repeat(40),
        previousVersion: 'b'.repeat(40),
        backupDir: null,
        phase: 'done',
        failure: null,
        warning: null,
        startedAt: FIXED.toISOString(),
        finishedAt: FIXED.toISOString(),
        durationMs: 60_000,
      }
    },
  })
  try {
    store.create({ messageId: 'om_1', chatId: 'oc_1', text: '加导出按钮', at: 'x', state: 'gated' })
    const outcome = await coordinator.handle(message({ text: '部署' }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(outcome.note, 'deploy:command')
    assert.equal(deployCalls.length, 1, 'deploy 动作要真触发部署')
    assert.equal(store.all().length, 1, '部署指令不建单')
    assert.equal(store.all()[0].state, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('调度器收到的上下文带工单事实与硬判定结果', async () => {
  const captured: DispatchInput[] = []
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-ctx-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/x',
    nodePath: '/x',
    repoPath: '/x',
    now: () => FIXED,
    log: () => {},
    runHarnessImpl: async () => harnessOk(),
    dispatchImpl: async (input) => {
      captured.push(input)
      return { action: { kind: 'reply', text: '好' }, source: 'model' }
    },
    progressNoticeMs: 0,
    cardUpdateMs: -1,
  })
  try {
    const ticket = store.create({ messageId: 'om_old', chatId: 'oc_1', text: '已有一张单', at: 'x', state: 'gated' })
    store.bindCard(ticket.id, 'om_card_x', 'x')

    await coordinator.handle(message({ messageId: 'om_a', text: '加个导出按钮', parentId: 'om_card_x' }))
    await coordinator.drain()

    assert.equal(captured.length, 1)
    assert.equal(captured[0].replyingToTicketNo, ticket.no, '硬判定结果要告诉模型')
    assert.ok(captured[0].tickets.some((summary) => summary.no === ticket.no), '工单事实要带上')
    assert.deepEqual(captured[0].gated, [ticket.no], '待部署单要带上')
    assert.equal(captured[0].deployEnabled, false, '测试环境没配部署')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('施工中主动同步：开工播报 + 收尾播报 + 卡片阶段 + 落库进度（无心跳）', async () => {
  const clock = { ms: FIXED.getTime() }
  const runner = async (input: { onEvent?: (event: HarnessEvent) => void }) => {
    input.onEvent?.({ type: 'session', sessionId: 'session-9' })
    clock.ms += 20_000
    input.onEvent?.({ type: 'tool_call', name: 'read', input: { path: 'apps/web/app/a.tsx' } })
    clock.ms += 20_000
    input.onEvent?.({ type: 'tool_call', name: 'edit', input: { path: 'apps/web/app/b.tsx' } })
    clock.ms += 300_000 // 5 分钟没有事件：旧实现这里会发心跳，现在不应发
    input.onEvent?.({ type: 'tool_call', name: 'bash', input: { command: 'npm run typecheck' } })
    clock.ms += 20_000
    input.onEvent?.({ type: 'final', text: '修复完成，已提交' })
    return harnessOk('session-9', '修复完成，已提交')
  }
  const { dir, store, transport, coordinator } = setup({
    dispatch: { kind: 'create_ticket' },
    runner,
    clock,
    cardUpdateMs: 5_000,
  })
  try {
    await coordinator.handle(message({ text: '采购单搜索框希望能按供应商搜' }))
    await coordinator.drain()

    const replies = transport.ofKind('reply').map((record) => record.payload)
    assert.equal(replies.filter((line) => line.includes('已开工')).length, 1, '开工一条')
    assert.equal(replies.filter((line) => line.includes('收尾')).length, 1, '收尾一条')
    assert.equal(replies.length, 2, `群里只应有两条播报，实际：${replies.join(' | ')}`)

    const updates = transport.ofKind('update')
    assert.ok(updates.some((record) => record.card?.title === '施工中｜T-0001'), '要有施工中卡片')
    assert.ok(
      updates.some((record) => record.card?.lines.some((line) => line.includes('在改代码'))),
      '卡片要反映阶段',
    )
    assert.equal(updates.at(-1)?.card?.template, 'green', '结束要转绿卡')

    const ticket = store.all()[0]
    assert.equal(ticket.state, 'gated')
    assert.equal(ticket.progress?.toolCalls, 3)
    assert.equal(ticket.progress?.filesChanged, 2)
    assert.equal(ticket.progress?.phase, 'finishing')
    assert.equal(ticket.result?.summary, '修复完成，已提交')
  } finally {
    cleanup(dir)
  }
})

test('排队位次要写进卡片：第二张单能看到前面还有 1 张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-queue-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  let releaseRef: { fn: (() => void) | null } = { fn: null }
  const gate = new Promise<void>((resolve) => {
    releaseRef.fn = resolve
  })
  let calls = 0
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/x',
    nodePath: '/x',
    repoPath: '/x',
    now: () => FIXED,
    log: () => {},
    dispatchImpl: async () => ({ action: { kind: 'create_ticket' }, source: 'model' }),
    runHarnessImpl: async () => {
      calls += 1
      if (calls === 1) await gate
      return harnessOk()
    },
    progressNoticeMs: 0,
    cardUpdateMs: -1,
  })

  try {
    await coordinator.handle(message({ messageId: 'om_a' }))
    await coordinator.handle(message({ messageId: 'om_b', text: '采购单列表加一个供应商列' }))
    await Promise.resolve()
    await Promise.resolve()

    const cards = transport.ofKind('card')
    assert.equal(cards.length, 2)
    assert.ok(
      cards[1].card?.lines.some((line) => line.includes('前面还有 1 张单')),
      '第二张单要能看出排队位次',
    )

    releaseRef.fn?.()
    await coordinator.drain()
    assert.equal(store.all().length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
