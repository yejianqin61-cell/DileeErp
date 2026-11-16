import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent, extractTicketNo, normalizeText, type Intent } from '../src/intent.ts'

interface Case {
  readonly text: string
  readonly intent: Intent
  readonly ticketNo?: string | null
}

/**
 * 真实语料优先：前几条直接来自 2026-11-15 真实群里的消息与当时错误的处理结果。
 * 这些是这套判定存在的理由，不能只测构造出来的理想句子。
 */
const CASES: readonly Case[] = [
  // —— 真实事故：问进度被当成需求 ——
  { text: '汇报T-0007进度', intent: 'status', ticketNo: 'T-0007' },
  { text: '针对工单T-0007，汇报进度', intent: 'status', ticketNo: 'T-0007' },
  { text: '@迪礼顾问 汇报T-0007进度', intent: 'status', ticketNo: 'T-0007' },
  // —— 真实语料：招呼 / 情绪 / 操作 ——
  { text: '你好', intent: 'chitchat' },
  { text: '卧槽你特么是傻逼吗', intent: 'chitchat' },
  { text: '部署', intent: 'command' },
  { text: '部署吧', intent: 'command' },
  // —— 进度询问的各种说法 ——
  { text: 'T-0007 进度', intent: 'status', ticketNo: 'T-0007' },
  { text: 'T-0007', intent: 'status', ticketNo: 'T-0007' },
  { text: '进度', intent: 'status' },
  { text: '改好了吗', intent: 'status' },
  { text: '那个物料下拉的问题修好了吗', intent: 'status' },
  { text: '查一下 T-0007', intent: 'status', ticketNo: 'T-0007' },
  { text: 'T-0007 怎么样了', intent: 'status', ticketNo: 'T-0007' },
  { text: '领料单什么时候能做好', intent: 'status' },
  // —— 仍然是需求：不能被意图层抢走 ——
  { text: '进度条改成蓝色', intent: 'requirement' },
  { text: '把部署脚本改成幂等', intent: 'requirement' },
  { text: '新建领料单页面，物料明细表单，物料选择的下拉列表打不开', intent: 'requirement' },
  { text: '采购单列表页的搜索框，希望能按供应商名称搜', intent: 'requirement' },
  { text: '能不能支持按供应商名称搜', intent: 'requirement' },
  { text: '改成按单号倒序', intent: 'requirement' },
  { text: '销售单列表要能按客户筛选', intent: 'requirement' },
  { text: '这个不对', intent: 'requirement' },
  // —— 提问：问用法 / 问能力 ——
  { text: '怎么导出销售单', intent: 'question' },
  { text: '销售单列表怎么排序', intent: 'question' },
  { text: '有没有导出功能', intent: 'question' },
  { text: '采购单为什么打不开', intent: 'question' },
  // —— 闲聊 ——
  { text: '在吗', intent: 'chitchat' },
  { text: '你是谁', intent: 'chitchat' },
  { text: '谢谢', intent: 'chitchat' },
  { text: '好的', intent: 'chitchat' },
  { text: '哈哈哈', intent: 'chitchat' },
  { text: '？？', intent: 'chitchat' },
]

for (const item of CASES) {
  test(`意图：${item.text}`, () => {
    const result = classifyIntent(item.text)
    assert.equal(result.intent, item.intent, `reason=${result.reason}`)
    if (item.ticketNo !== undefined) assert.equal(result.ticketNo, item.ticketNo)
  })
}

test('工单号：支持 T-0007 / T0007 / t-7 / 工单7，不误吃 T恤', () => {
  assert.equal(extractTicketNo('T-0007'), 'T-0007')
  assert.equal(extractTicketNo('T0007'), 'T-0007')
  assert.equal(extractTicketNo('t-7'), 'T-0007')
  assert.equal(extractTicketNo('工单7'), 'T-0007')
  assert.equal(extractTicketNo('工单 T-0012'), 'T-0012')
  assert.equal(extractTicketNo('T恤要改'), null)
  assert.equal(extractTicketNo('没有票号'), null)
})

test('normalizeText 去掉 @占位符与多余空白', () => {
  assert.equal(normalizeText('  @_user_1  汇报 T-0007  进度 '), '汇报 T-0007 进度')
})

test('判定理由是可见的：出问题能据此复现', () => {
  assert.match(classifyIntent('汇报T-0007进度').reason, /状态词/)
  assert.match(classifyIntent('部署').reason, /操作指令/)
  assert.match(classifyIntent('怎么导出').reason, /问句/)
  assert.match(classifyIntent('改成按单号倒序').reason, /改动动词/)
})
