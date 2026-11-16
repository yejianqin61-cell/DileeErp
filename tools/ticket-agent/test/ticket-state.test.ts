import assert from 'node:assert/strict'
import test from 'node:test'

import { TicketError, TicketRegistry, allowedTransitions, isTerminal } from '../src/ticket-state.ts'

const at = '2026-11-14T08:00:00.000Z'

function makeRegistry() {
  return new TicketRegistry()
}

function receive(registry: TicketRegistry, messageId = 'om_1') {
  return registry.receive({
    messageId,
    chatId: 'oc_1',
    senderOpenId: 'ou_1',
    text: '采购单列表页报错，应该能显示',
    at,
  })
}

test('同一 message_id 重投只产生一张工单', () => {
  const registry = makeRegistry()
  const first = receive(registry)
  const second = receive(registry)

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.ticket.id, second.ticket.id)
  assert.equal(registry.all().length, 1)
})

test('不同 message_id 产生不同工单', () => {
  const registry = makeRegistry()
  receive(registry, 'om_1')
  receive(registry, 'om_2')
  assert.equal(registry.all().length, 2)
})

test('缺 messageId 或 chatId 时拒绝', () => {
  const registry = makeRegistry()
  assert.throws(
    () => registry.receive({ messageId: '', chatId: 'oc_1', senderOpenId: '', text: 'x', at }),
    (error: unknown) => error instanceof TicketError && error.code === 'missing-field',
  )
})

test('分诊齐全时 received → triaged', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  const updated = registry.applyTriage(ticket.id, {
    module: 'procurement',
    expected: '应该能显示',
    entry: '采购单列表',
    missing: [],
    summary: '缺陷｜采购单列表',
  }, at)

  assert.equal(updated.state, 'triaged')
})

test('分诊缺项时 received → needs_info，并可继续 triaged', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  const needsInfo = registry.applyTriage(ticket.id, {
    module: null,
    expected: null,
    entry: null,
    missing: ['module', 'expected', 'entry'],
    summary: '待补充',
  }, at)
  assert.equal(needsInfo.state, 'needs_info')

  // 用户补充信息后，同一张工单继续往前走，不另开新单
  const triaged = registry.applyTriage(ticket.id, {
    module: 'finance',
    expected: '应该按客户排序',
    entry: '应收列表',
    missing: [],
    summary: '需求｜应收列表',
  }, at)
  assert.equal(triaged.state, 'triaged')
  assert.equal(registry.all().length, 1)
})

test('非法迁移被拒绝，不静默忽略', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)

  assert.throws(
    () => registry.transition(ticket.id, 'deploying', at),
    (error: unknown) => error instanceof TicketError && error.code === 'invalid-transition',
  )
})

test('终态拒绝一切迁移：重投事件不能改写已完成的工单', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  registry.applyTriage(ticket.id, {
    module: 'sales', expected: 'x', entry: 'y', missing: [], summary: '缺陷｜销售',
  }, at)
  registry.transition(ticket.id, 'queued', at)
  registry.transition(ticket.id, 'building', at)
  registry.transition(ticket.id, 'gated', at)
  registry.transition(ticket.id, 'deploying', at)
  registry.transition(ticket.id, 'done', at)

  assert.equal(isTerminal(ticket.state), true)
  assert.throws(
    () => registry.transition(ticket.id, 'failed', at),
    (error: unknown) => error instanceof TicketError && error.code === 'ticket-already-terminal',
  )
})

test('完整正向链路可达 done', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  registry.applyTriage(ticket.id, {
    module: 'sales', expected: 'x', entry: 'y', missing: [], summary: '缺陷｜销售',
  }, at)
  for (const state of ['queued', 'building', 'gated', 'deploying', 'done'] as const) {
    registry.transition(ticket.id, state, at)
  }
  assert.equal(ticket.state, 'done')
})

test('部署失败后可以回滚或失败，且都不可再迁移', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  registry.applyTriage(ticket.id, {
    module: 'sales', expected: 'x', entry: 'y', missing: [], summary: '缺陷｜销售',
  }, at)
  for (const state of ['queued', 'building', 'gated', 'deploying'] as const) {
    registry.transition(ticket.id, state, at)
  }
  registry.transition(ticket.id, 'rolled_back', at)

  assert.equal(ticket.state, 'rolled_back')
  assert.throws(
    () => registry.transition(ticket.id, 'done', at),
    (error: unknown) => error instanceof TicketError && error.code === 'ticket-already-terminal',
  )
})

test('历史记录每一步，可用于证据目录', () => {
  const registry = makeRegistry()
  const { ticket } = receive(registry)
  registry.applyTriage(ticket.id, {
    module: 'sales', expected: 'x', entry: 'y', missing: [], summary: '缺陷｜销售',
  }, at)
  registry.transition(ticket.id, 'queued', at, 'triage ok')

  // 创建时记一条，分诊一条，入队一条
  assert.equal(ticket.history.length, 3)
  assert.equal(ticket.history[2].to, 'queued')
  assert.equal(ticket.history[2].note, 'triage ok')
})

test('不存在的工单报 ticket-not-found', () => {
  const registry = makeRegistry()
  assert.throws(
    () => registry.get('T-nope'),
    (error: unknown) => error instanceof TicketError && error.code === 'ticket-not-found',
  )
})

test('终态集合与迁移表一致：终态无出边', () => {
  for (const state of ['done', 'failed', 'rolled_back'] as const) {
    assert.equal(allowedTransitions(state).length, 0, `${state} 不应有出边`)
  }
})
