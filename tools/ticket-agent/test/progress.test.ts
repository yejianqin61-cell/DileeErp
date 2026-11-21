import assert from 'node:assert/strict'
import test from 'node:test'

import type { HarnessEvent } from '../src/harness-runner.ts'
import {
  INITIAL_PROGRESS,
  applyEvent,
  formatDuration,
  fromStored,
  overviewText,
  phaseForTool,
  phaseFromString,
  phaseLabel,
  progressCard,
  stateLabel,
  statusText,
  toStoredProgress,
  toView,
} from '../src/progress.ts'
import type { StoredTicket, TicketProgress, TicketResult } from '../src/ticket-store.ts'

const START = Date.parse('2026-11-16T04:00:00.000Z')

function ticket(overrides: Partial<StoredTicket> = {}): StoredTicket {
  return {
    id: 'tk_test',
    no: 'T-0007',
    chatId: 'oc_1',
    cardMessageId: 'om_card',
    sessionId: 'session-1',
    state: 'building',
    turns: [
      {
        messageId: 'om_1',
        text: '针对新建领料单页面，物料明细表单，物料选择的下拉列表打不开',
        at: '2026-11-16T04:00:00.000Z',
        kind: 'create',
      },
    ],
    createdAt: '2026-11-16T04:00:00.000Z',
    updatedAt: '2026-11-16T04:00:00.000Z',
    ...overrides,
  }
}

function progress(overrides: Partial<TicketProgress> = {}): TicketProgress {
  return {
    phase: 'editing',
    startedAt: new Date(START).toISOString(),
    updatedAt: new Date(START + 392_000).toISOString(),
    toolCalls: 23,
    subagentCalls: 1,
    filesChanged: 3,
    lastAction: 'edit apps/web/app/production/material-picker.tsx',
    lastText: '改好了下拉层的 z-index',
    ...overrides,
  }
}

function result(overrides: Partial<TicketResult> = {}): TicketResult {
  return {
    outcome: 'completed',
    summary: '修复了领料单物料下拉被表格裁切的问题。',
    durationMs: 883_000,
    at: '2026-11-16T04:15:00.000Z',
    ...overrides,
  }
}

function event(overrides: Partial<HarnessEvent> & { type: string }): HarnessEvent {
  return overrides as HarnessEvent
}

test('applyEvent：读代码 → 改代码 → 跑命令 → 收尾，计数与文件去重', () => {
  let state = INITIAL_PROGRESS
  state = applyEvent(state, event({ type: 'session', sessionId: 'session-1' }))
  assert.equal(state.phase, 'starting')

  state = applyEvent(state, event({ type: 'tool_call', name: 'read', input: { path: 'apps/web/a.tsx' } }))
  assert.equal(state.phase, 'reading')
  assert.equal(state.toolCalls, 1)
  assert.deepEqual(state.files, ['apps/web/a.tsx'])

  state = applyEvent(state, event({ type: 'tool_call', name: 'edit', input: { path: 'apps/web/b.tsx' } }))
  assert.equal(state.phase, 'editing')
  assert.equal(state.toolCalls, 2)
  assert.equal(state.files.length, 2)
  assert.match(state.lastAction ?? '', /edit apps\/web\/b\.tsx/)

  // 同一个文件改两次，文件数不重复计
  state = applyEvent(state, event({ type: 'tool_call', name: 'edit', input: { path: 'apps/web/a.tsx' } }))
  assert.equal(state.files.length, 2, '同一文件不重复计数')

  state = applyEvent(state, event({ type: 'tool_call', name: 'bash', input: { command: 'npm run typecheck' } }))
  assert.equal(state.phase, 'verifying')

  state = applyEvent(state, event({ type: 'tool_call', name: 'subagent', input: { description: '审计' } }))
  assert.equal(state.phase, 'delegating')
  assert.equal(state.subagentCalls, 1)

  state = applyEvent(state, event({ type: 'final', text: 'done' }))
  assert.equal(state.phase, 'finishing')
})

test('applyEvent 不修改入参：事件流不该有副作用', () => {
  const before = INITIAL_PROGRESS
  const after = applyEvent(before, event({ type: 'tool_call', name: 'edit', input: { path: 'x.ts' } }))
  assert.equal(before.toolCalls, 0)
  assert.equal(before.files.length, 0)
  assert.notEqual(before, after)
})

test('applyEvent：未知事件与未知工具不改阶段，但工具调用仍计数', () => {
  let state = applyEvent(INITIAL_PROGRESS, event({ type: 'tool_call', name: 'whatever' }))
  assert.equal(state.toolCalls, 1)
  assert.equal(state.phase, 'starting')
  state = applyEvent(state, event({ type: 'thinking' }))
  assert.equal(state.toolCalls, 1)
})

test('phaseForTool：名字里带大小写与路径也不误判', () => {
  assert.equal(phaseForTool('Read'), 'reading')
  assert.equal(phaseForTool('apply_patch'), 'editing')
  assert.equal(phaseForTool('run_command'), 'verifying')
  assert.equal(phaseForTool('subagent_control'), 'delegating')
  assert.equal(phaseForTool('totally_unknown'), null)
  assert.equal(phaseLabel('verifying'), '在跑命令/验证')
})

test('formatDuration：秒 / 分秒 / 时分', () => {
  assert.equal(formatDuration(43_000), '43 秒')
  assert.equal(formatDuration(392_000), '6 分 32 秒')
  assert.equal(formatDuration(360_000), '6 分')
  assert.equal(formatDuration(3_720_000), '1 小时 2 分')
  assert.equal(formatDuration(-5), '0 秒')
})

test('落库形状与视图可往返', () => {
  const view = toView(
    { ...INITIAL_PROGRESS, phase: 'verifying', toolCalls: 7, subagentCalls: 2, files: ['a.ts', 'b.ts'] },
    START,
  )
  const stored = toStoredProgress({
    view,
    startedAt: new Date(START).toISOString(),
    updatedAt: new Date(START + 1000).toISOString(),
  })
  const back = fromStored(stored)
  assert.ok(back !== null)
  assert.equal(back.phase, 'verifying')
  assert.equal(back.toolCalls, 7)
  assert.equal(back.subagentCalls, 2)
  assert.equal(back.filesChanged, 2)
  assert.equal(back.startedAtMs, START)
  assert.equal(fromStored(null), null)
  assert.equal(phaseFromString('没见过的阶段'), 'starting')
})

test('施工中：回答带已用时长、当前阶段、过程与改动文件数', () => {
  const text = statusText({
    ticket: ticket({ progress: progress() }),
    nowMs: START + 392_000,
    queueAhead: 0,
  })
  assert.match(text, /T-0007｜施工中，已用 6 分 32 秒/)
  assert.match(text, /当前：在改代码/)
  assert.match(text, /工具调用 23 次，其中派发子 Agent 1 次/)
  assert.match(text, /改动：已触及 3 个文件/)
  assert.match(text, /原话：针对新建领料单页面/)
})

test('排队中：回答给位次，而不是「不知道」', () => {
  const text = statusText({ ticket: ticket({ state: 'queued' }), nowMs: START, queueAhead: 2 })
  assert.match(text, /T-0007｜排队中/)
  assert.match(text, /前面还有 2 张单在跑/)
  assert.match(text, /轮到你时会自动开工/)
})

test('已完成：回答给结论与用时', () => {
  const text = statusText({ ticket: ticket({ state: 'gated', result: result() }), nowMs: START, queueAhead: 0 })
  assert.match(text, /T-0007｜已完成，产出待部署/)
  assert.match(text, /结论：修复了领料单物料下拉/)
  assert.match(text, /用时：14 分 43 秒/)
  assert.match(text, /回复这张卡片可以直接提改进需求/)
})

test('失败：回答给原因并指出可以重跑', () => {
  const text = statusText({
    ticket: ticket({ state: 'failed', result: result({ outcome: 'timeout', summary: '超过 2700000ms 未结束' }) }),
    nowMs: START,
    queueAhead: 0,
  })
  assert.match(text, /未完成/)
  assert.match(text, /原因：超过 2700000ms 未结束/)
  assert.match(text, /重新跑一轮/)
})

test('缺信息：回答说清缺什么、怎么补', () => {
  const text = statusText({ ticket: ticket({ state: 'needs_info' }), nowMs: START, queueAhead: 0 })
  assert.match(text, /还缺信息，没开工/)
  assert.match(text, /你希望它变成什么样/)
  assert.match(text, /直接再发一条消息补充/)
})

test('总览：列出在跑与最近完成，没单时也给人话', () => {
  const text = overviewText({
    tickets: [
      ticket({ no: 'T-0005', state: 'gated', result: result({ summary: '加了导出按钮' }) }),
      ticket({ no: 'T-0007', state: 'building', progress: progress() }),
      ticket({ no: 'T-0008', state: 'queued', turns: [{ messageId: 'om_8', text: '采购单加一列供应商', at: '', kind: 'create' }] }),
    ],
    nowMs: START + 392_000,
  })
  assert.match(text, /当前在用 2 张单/)
  assert.match(text, /T-0007 施工中，已用 6 分 32 秒/)
  assert.match(text, /T-0008 排队中/)
  assert.match(text, /T-0005 已完成，待部署/)
  assert.match(text, /要问某一张的细节/)

  const empty = overviewText({ tickets: [], nowMs: START })
  assert.match(empty, /现在没有在跑的单/)
})

test('进度卡片：蓝色、标题带票号、脚注说明可追加', () => {
  const card = progressCard({
    ticketNo: 'T-0007',
    view: toView(INITIAL_PROGRESS, START),
    nowMs: START,
    queueAhead: 0,
  })
  assert.equal(card.template, 'blue')
  assert.match(card.title, /施工中｜T-0007/)
  assert.ok(card.lines.some((line) => line.includes('已用')))
  assert.match(card.footer ?? '', /回复这张卡片可追加需求/)
})

test('进度卡片只有三行：已用 / 当前 / 改动，不再塞自述原文', () => {
  const view = toView(
    {
      ...INITIAL_PROGRESS,
      phase: 'editing',
      toolCalls: 31,
      subagentCalls: 1,
      files: ['a', 'b', 'c'],
      lastText: '我把下拉层改成 SearchableSelect 了，正在补测试',
    },
    START,
  )
  const card = progressCard({ ticketNo: 'T-0007', view, nowMs: START + 492_000, queueAhead: 0 })
  assert.equal(card.lines.length, 3, `实际 ${card.lines.length} 行：${card.lines.join(' / ')}`)
  assert.ok(!card.lines.some((line) => line.includes('我把下拉层')), '自述原文不该进卡片')
  assert.ok(!card.lines.some((line) => line.includes('工具调用')), '工具调用数不该进卡片')
})

test('九态中文标签覆盖全部状态', () => {
  for (const [state, label] of Object.entries({
    received: '已受理',
    needs_info: '等补充信息',
    triaged: '已分诊',
    queued: '排队中',
    building: '施工中',
    gated: '已完成，待部署',
    deploying: '部署中',
    done: '已上线',
    failed: '未完成',
    rolled_back: '已回滚',
  })) {
    assert.equal(stateLabel(state), label)
  }
  assert.equal(stateLabel('未知态'), '未知态')
})
