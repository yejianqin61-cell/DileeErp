import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Coordinator } from '../src/coordinator.ts'
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

function setup(options: {
  runner?: (input: { onEvent?: (event: HarnessEvent) => void; sessionId?: string }) => Promise<HarnessResult>
  progressNoticeMs?: number
  cardUpdateMs?: number
  clock?: { ms: number }
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-intent-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  const logs: string[] = []
  const prompts: string[] = []
  const runnerCalls: Array<{ sessionId?: string }> = []
  const answers: Array<{ question: string }> = []
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
    answererKey: 'sk-test',
    answererImpl: async (input) => {
      answers.push({ question: input.question })
      return { text: '在销售单列表右上角点「导出」。', source: 'model' }
    },
    progressNoticeMs: options.progressNoticeMs ?? 0,
    cardUpdateMs: options.cardUpdateMs ?? -1,
  })

  return { dir, store, transport, logs, prompts, runnerCalls, answers, clock, coordinator }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

test('问进度：不建单，直接用本地事实回答', async () => {
  const { dir, store, transport, coordinator } = setup()
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
  const { dir, store, transport, coordinator } = setup()
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

test('票号不存在：明确说没找到，并给最近工单', async () => {
  const { dir, store, coordinator, transport } = setup()
  try {
    store.create({ messageId: 'om_1', chatId: 'oc_1', text: '第一个需求', at: 'x', state: 'gated' })
    await coordinator.handle(message({ text: 'T-0099 进度' }))
    await coordinator.drain()
    assert.equal(store.all().length, 1)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /没找到 T-0099/)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /T-0001/)
  } finally {
    cleanup(dir)
  }
})

test('提问：交给问答模型回答，不建单、不跑 DSH', async () => {
  const { dir, store, transport, answers, runnerCalls, coordinator } = setup()
  try {
    const outcome = await coordinator.handle(message({ text: '怎么导出销售单' }))
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(store.all().length, 0, '提问不建单')
    assert.equal(runnerCalls.length, 0, '提问不占改代码车道')
    assert.equal(answers.length, 1)
    assert.equal(answers[0].question, '怎么导出销售单')
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /右上角点「导出」/)
  } finally {
    cleanup(dir)
  }
})

test('招呼与情绪话：回人话，不建单', async () => {
  const { dir, store, transport, coordinator } = setup()
  try {
    await coordinator.handle(message({ text: '你好' }))
    await coordinator.drain()
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /迪礼顾问/)

    await coordinator.handle(message({ messageId: 'om_2', text: '卧槽你特么是傻逼吗' }))
    await coordinator.drain()
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /把页面和现象发我/)

    assert.equal(store.all().length, 0)
  } finally {
    cleanup(dir)
  }
})

test('「部署」：如实说通道未接通，并给待部署清单', async () => {
  const { dir, store, transport, coordinator } = setup()
  try {
    store.create({ messageId: 'om_1', chatId: 'oc_1', text: '加导出按钮', at: 'x', state: 'gated' })
    await coordinator.handle(message({ text: '部署' }))
    await coordinator.drain()
    const reply = transport.ofKind('reply').at(-1)?.payload ?? ''
    assert.match(reply, /部署通道还没接通/)
    assert.match(reply, /T-0001/)
    assert.equal(store.all().length, 1, '部署指令不建单')
  } finally {
    cleanup(dir)
  }
})

test('施工中主动同步：开工播报 + 阶段卡片 + 心跳 + 落库进度', async () => {
  const clock = { ms: FIXED.getTime() }
  const runner = async (input: { onEvent?: (event: HarnessEvent) => void }) => {
    input.onEvent?.({ type: 'session', sessionId: 'session-9' })
    clock.ms += 20_000
    input.onEvent?.({ type: 'tool_call', name: 'read', input: { path: 'apps/web/app/a.tsx' } })
    clock.ms += 20_000
    input.onEvent?.({ type: 'tool_call', name: 'edit', input: { path: 'apps/web/app/b.tsx' } })
    clock.ms += 300_000 // 5 分钟没有事件，验证心跳
    input.onEvent?.({ type: 'tool_call', name: 'bash', input: { command: 'npm run typecheck' } })
    clock.ms += 20_000
    input.onEvent?.({ type: 'final', text: '修复完成，已提交' })
    return harnessOk('session-9', '修复完成，已提交')
  }
  const { dir, store, transport, coordinator } = setup({
    runner,
    clock,
    progressNoticeMs: 60_000,
    cardUpdateMs: 5_000,
  })
  try {
    await coordinator.handle(message({ text: '采购单搜索框希望能按供应商搜' }))
    await coordinator.drain()

    const replies = transport.ofKind('reply').map((record) => record.payload)
    assert.ok(replies[0].includes('已开工'), '开工要有播报')
    assert.ok(replies.some((line) => /在跑命令/.test(line) && /工具调用 3 次/.test(line)), '安静 5 分钟要有心跳')

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
    cleanup(dir)
  }
})

test('含糊需求：追问用「补一点」，不再说「补两点」', async () => {
  const { dir, store, transport, coordinator } = setup()
  try {
    const outcome = await coordinator.handle(message({ text: '这个不对' }))
    await coordinator.drain()
    assert.equal(outcome.outcome, 'needs-info')
    const reply = transport.ofKind('reply').at(-1)?.payload ?? ''
    assert.match(reply, /补一点/)
    assert.doesNotMatch(reply, /补两点/)
    assert.match(reply, /直接再发一条消息补充/)
    assert.equal(store.all().length, 1)
  } finally {
    cleanup(dir)
  }
})
