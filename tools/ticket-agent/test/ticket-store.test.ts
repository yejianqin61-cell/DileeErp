import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TicketStore,
  TicketStoreError,
  formatTicketNo,
  parseTicketNo,
} from '../src/ticket-store.ts'

const at = '2026-11-14T09:00:00.000Z'

function withStore(fn: (store: TicketStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-tickets-'))
  try {
    fn(new TicketStore(dir), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('短号从 T-0001 开始递增', () => {
  withStore((store) => {
    const a = store.create({ messageId: 'om_1', chatId: 'oc_1', text: '需求一', at, state: 'received' })
    const b = store.create({ messageId: 'om_2', chatId: 'oc_1', text: '需求二', at, state: 'received' })
    assert.equal(a.no, 'T-0001')
    assert.equal(b.no, 'T-0002')
  })
})

test('同一 message_id 重复创建返回同一张工单，不消耗短号', () => {
  withStore((store) => {
    const a = store.create({ messageId: 'om_same', chatId: 'oc_1', text: 'x', at, state: 'received' })
    const b = store.create({ messageId: 'om_same', chatId: 'oc_1', text: 'x', at, state: 'received' })
    assert.equal(a.id, b.id)
    assert.equal(a.no, b.no)
    // 下一张应该是 T-0002，说明没有浪费号
    const c = store.create({ messageId: 'om_other', chatId: 'oc_1', text: 'y', at, state: 'received' })
    assert.equal(c.no, 'T-0002')
  })
})

test('重启后短号继续递增，不重置', () => {
  withStore((_store, dir) => {
    const first = new TicketStore(dir)
    first.create({ messageId: 'om_a', chatId: 'oc_1', text: 'a', at, state: 'received' })
    first.create({ messageId: 'om_b', chatId: 'oc_1', text: 'b', at, state: 'received' })

    // 模拟进程重启：同一目录新建实例
    const second = new TicketStore(dir)
    const third = second.create({ messageId: 'om_c', chatId: 'oc_1', text: 'c', at, state: 'received' })
    assert.equal(third.no, 'T-0003')
  })
})

test('卡片反查：绑定后可回查，未绑定返回 null', () => {
  withStore((store) => {
    const ticket = store.create({ messageId: 'om_1', chatId: 'oc_1', text: 'x', at, state: 'received' })
    assert.equal(store.findByCard('om_card_1'), null)

    store.bindCard(ticket.id, 'om_card_1', at)
    const found = store.findByCard('om_card_1')
    assert.equal(found?.id, ticket.id)
    assert.equal(found?.cardMessageId, 'om_card_1')
  })
})

test('会话 id 绑定后可回读', () => {
  withStore((store) => {
    const ticket = store.create({ messageId: 'om_1', chatId: 'oc_1', text: 'x', at, state: 'received' })
    assert.equal(ticket.sessionId, null)
    const bound = store.bindSession(ticket.id, 'session-abc', at)
    assert.equal(bound.sessionId, 'session-abc')
    assert.equal(store.get(ticket.id)?.sessionId, 'session-abc')
  })
})

test('追加轮次：原话按轮累积，不覆盖', () => {
  withStore((store) => {
    const ticket = store.create({ messageId: 'om_1', chatId: 'oc_1', text: '第一轮', at, state: 'received' })
    store.appendTurn(ticket.id, { messageId: 'om_2', text: '第二轮追加', at })
    const updated = store.get(ticket.id)
    assert.equal(updated?.turns.length, 2)
    assert.equal(updated?.turns[0].text, '第一轮')
    assert.equal(updated?.turns[0].kind, 'create')
    assert.equal(updated?.turns[1].text, '第二轮追加')
    assert.equal(updated?.turns[1].kind, 'append')
  })
})

test('按短号查找与排序', () => {
  withStore((store) => {
    store.create({ messageId: 'om_1', chatId: 'oc_1', text: 'a', at, state: 'received' })
    store.create({ messageId: 'om_2', chatId: 'oc_1', text: 'b', at, state: 'received' })
    assert.equal(store.getByNo('T-0002')?.turns[0].text, 'b')
    assert.deepEqual(store.all().map((t) => t.no), ['T-0001', 'T-0002'])
  })
})

test('索引损坏时明确报错，不静默从头编号', () => {
  withStore((_store, dir) => {
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ nextNo: 0 }), 'utf8')
    const store = new TicketStore(dir)
    assert.throws(
      () => store.create({ messageId: 'om_x', chatId: 'oc_1', text: 'x', at, state: 'received' }),
      (error: unknown) => error instanceof TicketStoreError && error.code === 'corrupt-index',
    )
  })
})

test('写入是原子的：目录里不残留临时文件', () => {
  withStore((store, dir) => {
    const ticket = store.create({ messageId: 'om_1', chatId: 'oc_1', text: 'x', at, state: 'received' })
    store.bindCard(ticket.id, 'om_card', at)
    store.setState(ticket.id, 'queued', at)

    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  })
})

test('工单 JSON 可被重新解析，字段完整', () => {
  withStore((store, dir) => {
    const ticket = store.create({ messageId: 'om_1', chatId: 'oc_1', text: '原话', at, state: 'received' })
    const raw = JSON.parse(readFileSync(join(dir, `${ticket.id}.json`), 'utf8'))
    assert.equal(raw.no, 'T-0001')
    assert.equal(raw.chatId, 'oc_1')
    assert.equal(raw.state, 'received')
    assert.equal(raw.turns[0].text, '原话')
  })
})

test('格式化与反解短号', () => {
  assert.equal(formatTicketNo(1), 'T-0001')
  assert.equal(formatTicketNo(9999), 'T-9999')
  assert.equal(parseTicketNo('T-0007'), 7)
  assert.equal(parseTicketNo('bad'), 0)
  assert.throws(() => formatTicketNo(0), TicketStoreError)
})

test('不存在的工单：get 返回 null，setState 抛错', () => {
  withStore((store) => {
    assert.equal(store.get('tk_missing'), null)
    assert.throws(
      () => store.setState('tk_missing', 'queued', at),
      (error: unknown) => error instanceof TicketStoreError && error.code === 'ticket-not-found',
    )
  })
})

test('目录不存在时自动创建', () => {
  const base = mkdtempSync(join(tmpdir(), 'dilee-tickets-'))
  const nested = join(base, 'deep', 'nested')
  try {
    assert.equal(existsSync(nested), false)
    const store = new TicketStore(nested)
    store.create({ messageId: 'om_1', chatId: 'oc_1', text: 'x', at, state: 'received' })
    assert.equal(existsSync(nested), true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
