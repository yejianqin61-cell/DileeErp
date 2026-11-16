import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import { TicketFlow, cardHeadline } from '../src/ticket-flow.ts'
import { TicketRegistry } from '../src/ticket-state.ts'
import type { RawFeishuEvent } from '../src/feishu-event.ts'

const BOT = 'ou_bot_self'
const FIXED = new Date('2026-11-14T08:00:00.000Z')

function setup() {
  const transport = new FakeFeishuTransport()
  const registry = new TicketRegistry()
  const logs: string[] = []
  const flow = new TicketFlow(transport, registry, {
    botOpenId: BOT,
    log: (line) => logs.push(line),
    now: () => FIXED,
  })
  return { transport, registry, flow, logs }
}

function rawEvent(text: string, overrides: { messageId?: string; mentionBot?: boolean } = {}): RawFeishuEvent {
  const mentions = overrides.mentionBot === false
    ? []
    : [{ key: '@_user_1', id: { open_id: BOT }, mentioned_type: 'bot' }]
  return {
    schema: '2.0',
    header: { event_id: 'ev_1', event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
      message: {
        message_id: overrides.messageId ?? 'om_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
        mentions,
        create_time: '1762500000000',
      },
    },
  }
}

test('完整消息：建单、入队、回一张卡', async () => {
  const { transport, registry, flow } = setup()
  const result = await flow.handleRaw(
    rawEvent('@_user_1 采购单列表页的搜索框，希望能按供应商名称搜'),
  )

  assert.equal(result.outcome, 'queued')
  assert.equal(registry.all().length, 1)
  const cards = transport.ofKind('card')
  assert.equal(cards.length, 1)
  assert.ok(cards[0].card?.title.includes('排队'))
  // 卡片里必须有原话，用户才知道机器人理解了哪一条
  assert.ok(cards[0].card?.lines.some((line) => line.includes('采购单列表页的搜索框')))
})

test('重投同一条消息：不产生第二张卡，也不产生第二张工单', async () => {
  const { transport, registry, flow } = setup()
  const first = await flow.handleRaw(
    rawEvent('@_user_1 采购单列表页报错，应该能显示'),
  )
  const second = await flow.handleRaw(
    rawEvent('@_user_1 采购单列表页报错，应该能显示'),
  )

  assert.equal(first.outcome, 'queued')
  assert.equal(second.outcome, 'duplicate')
  assert.equal(registry.all().length, 1)
  assert.equal(transport.sent.length, 1, '重投不应产生任何新的飞书调用')
})

test('含糊消息：不建构建任务，改为追问', async () => {
  const { transport, registry, flow } = setup()
  const result = await flow.handleRaw(rawEvent('@_user_1 这个不对'))

  assert.equal(result.outcome, 'needs-info')
  assert.equal(registry.all().length, 1)
  // 追问走 replyText，而不是卡片
  assert.equal(transport.ofKind('reply').length, 1)
  assert.equal(transport.ofKind('card').length, 0)
  const reply = transport.ofKind('reply')[0]
  assert.ok(reply.payload.includes('希望它变成什么样'))
})

test('没 @机器人 的群消息完全不动', async () => {
  const { transport, flow } = setup()
  const result = await flow.handleRaw(rawEvent('@_user_1 随便聊聊', { mentionBot: false }))
  assert.equal(result.outcome, 'ignored')
  assert.equal(transport.sent.length, 0)
})

test('停止口令：清空后续，且重投仍然生效', async () => {
  const { transport, flow } = setup()
  const result = await flow.handleRaw(rawEvent('@_user_1 停止', { messageId: 'om_stop' }))

  assert.equal(result.outcome, 'stopped')
  assert.equal(flow.isStopped(), true)
  assert.equal(transport.ofKind('text').length, 1)

  // 停止后新工单不排队
  const after = await flow.handleRaw(
    rawEvent('@_user_1 销售单导出报错，应该能导出', { messageId: 'om_2' }),
  )
  assert.equal(after.outcome, 'stopped')
})

test('停止口令必须单独成句，不误伤正文里含「停止」的需求', async () => {
  const { flow } = setup()
  const result = await flow.handleRaw(
    rawEvent('@_user_1 生产日报页的停止按钮点了没反应，应该能停止计时'),
  )
  assert.notEqual(result.outcome, 'stopped')
  assert.equal(flow.isStopped(), false)
})

test('发卡片失败时工单落 failed，异常不冒泡', async () => {
  const { transport, registry, flow } = setup()
  // 第一次 sendCard 注入失败
  const original = transport.sendCard.bind(transport)
  let calls = 0
  transport.sendCard = async (chatId, card) => {
    calls += 1
    if (calls === 1) throw new Error('network down')
    return original(chatId, card)
  }

  const result = await flow.handleRaw(
    rawEvent('@_user_1 采购单列表页报错，应该能显示'),
  )
  // 入队时的卡片失败 → 走错误路径
  assert.equal(result.outcome, 'error')
  const ticket = registry.all()[0]
  assert.equal(ticket.state, 'failed')
})

test('卡片标题随状态变化，且色板语义固定', async () => {
  const { registry, flow } = setup()
  await flow.handleRaw(rawEvent('@_user_1 采购单列表页报错，应该能显示'))
  const ticket = registry.all()[0]

  assert.deepEqual(cardHeadline(ticket), { title: '已受理，排队中｜缺陷', template: 'blue' })

  registry.transition(ticket.id, 'building', FIXED.toISOString())
  assert.equal(cardHeadline(ticket).template, 'blue')

  registry.transition(ticket.id, 'gated', FIXED.toISOString())
  registry.transition(ticket.id, 'deploying', FIXED.toISOString())
  registry.transition(ticket.id, 'done', FIXED.toISOString())
  assert.deepEqual(cardHeadline(ticket), { title: '已上线｜缺陷', template: 'green' })
})

test('证据：每张卡片的 footer 带工单号与状态', async () => {
  const { transport, flow } = setup()
  await flow.handleRaw(rawEvent('@_user_1 采购单列表页报错，应该能显示'))
  const card = transport.ofKind('card')[0].card
  assert.ok(card?.footer?.includes('T-om_1'))
  assert.ok(card?.footer?.includes('queued'))
})
