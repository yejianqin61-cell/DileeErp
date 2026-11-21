/**
 * 用**真实工单目录的副本**回放一组 @ 消息，检查 Coordinator 的动作执行。
 *
 * 为什么用假调度器：这里要验证的是「模型给出某个动作后，Coordinator 做对了吗」——
 * 建单、追加、查进度、回复、部署各走各的路径。模型本身选什么动作由调度器单测与
 * 真机端到端覆盖，脚本里再调一次真模型只会让结果不可复现。
 *
 * 用法：
 *   node --import tsx scripts/replay-intents.ts /opt/dilee/agent/tickets
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Coordinator } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { DispatchAction, DispatchInput, DispatchOptions } from '../src/dispatcher.ts'
import type { DispatchResult } from '../src/dispatcher.ts'
import type { HarnessEvent, HarnessResult } from '../src/harness-runner.ts'
import { TicketStore } from '../src/ticket-store.ts'

const sourceDir = process.argv[2] ?? '/opt/dilee/agent/tickets'

const workDir = mkdtempSync(join(tmpdir(), 'dilee-replay-'))
cpSync(sourceDir, workDir, { recursive: true })

const store = new TicketStore(workDir)
const transport = new FakeFeishuTransport()

function fakeRun(input: { onEvent?: (event: HarnessEvent) => void }): Promise<HarnessResult> {
  const events: HarnessEvent[] = [
    { type: 'session', sessionId: 'session-replay' },
    { type: 'tool_call', name: 'read', input: { path: 'apps/web/app/procurement/list.tsx' } },
    { type: 'tool_call', name: 'edit', input: { path: 'apps/web/app/procurement/list.tsx' } },
    { type: 'tool_call', name: 'bash', input: { command: 'npm run typecheck' } },
    { type: 'final', text: '回放：已在搜索框接入供应商名称过滤（未真改代码）。' },
  ]
  for (const event of events) input.onEvent?.(event)
  return Promise.resolve({
    outcome: 'completed',
    sessionId: 'session-replay',
    finalText: '回放：已在搜索框接入供应商名称过滤（未真改代码）。',
    events,
    counts: { toolCalls: 3, subagentCalls: 0, textEvents: 1 },
    exitCode: 0,
    durationMs: 90_000,
  })
}

/** 假调度器：按原话匹配返回模型「本会选」的动作，模拟一次 LLM 调度。 */
function makeFakeDispatch(): (input: DispatchInput, options: DispatchOptions) => Promise<DispatchResult> {
  return async (input) => {
    const text = input.text.trim()
    const action = pickAction(text, input)
    return { action, source: 'model' }
  }
}

function pickAction(text: string, input: DispatchInput): DispatchAction {
  const statusMatch = /(?:汇报|查|看)?\s*(?:工单)?\s*(T-\d{3,4})\s*(?:的)?(?:进度|状态|情况|怎么样|如何)/.exec(text)
  if (statusMatch !== null) return { kind: 'status', ticketNo: statusMatch[1] }
  if (/^T-\d{3,4}$/.test(text)) return { kind: 'status', ticketNo: text }

  if (/部署|上线|发布/.test(text) && text.length <= 16) return { kind: 'deploy' }

  // 回复卡片：模拟「模型被告知上下文后选追加」
  if (input.replyingToTicketNo !== null) {
    return { kind: 'append_ticket', ticketNo: input.replyingToTicketNo }
  }

  // 明确的改动诉求
  if (/(能不能|支持|希望|加|改成|修|实现)/.test(text) && text.length >= 10) {
    return {
      kind: 'create_ticket',
      hint: { module: 'procurement', expected: '搜索框支持按供应商名称搜索', entry: null },
    }
  }

  // 其余一律当闲聊回复
  return { kind: 'reply', text: '我是迪礼顾问，迪礼 ERP 的维护助手。有要改的随时 @我。' }
}

const coordinator = new Coordinator({
  store,
  transport,
  dshBin: '/fake/dsh.js',
  nodePath: '/fake/node',
  repoPath: '/fake/repo',
  log: (line) => console.log(`  · ${line}`),
  dispatchImpl: makeFakeDispatch(),
  runHarnessImpl: async (input) => fakeRun(input),
  progressNoticeMs: 0,
  cardUpdateMs: 1,
})

/** 造一张「施工中」的票，用来验证进度回答。落库后重启也能答。 */
function seedBuildingTicket(): string {
  const ticket = store.create({
    messageId: 'om_replay_building',
    chatId: 'oc_replay',
    text: '新建领料单页面物料下拉打不开（回放用）',
    at: new Date().toISOString(),
    state: 'queued',
  })
  store.setState(ticket.id, 'building', new Date().toISOString())
  store.setProgress(
    ticket.id,
    {
      phase: 'editing',
      startedAt: new Date(Date.now() - 392_000).toISOString(),
      updatedAt: new Date().toISOString(),
      toolCalls: 23,
      subagentCalls: 1,
      filesChanged: 3,
      lastAction: 'edit apps/web/app/production/material-picker.tsx',
      lastText: '改了物料下拉的层级',
    },
    new Date().toISOString(),
  )
  return ticket.no
}

function messageFor(text: string, index: number) {
  return {
    messageId: `om_replay_${index}`,
    chatId: 'oc_replay',
    chatType: 'group' as const,
    senderOpenId: 'ou_replay',
    senderType: 'user',
    text,
    mentionsBot: true,
    eventId: `ev_replay_${index}`,
    createTime: String(Date.now()),
    threadId: null,
    parentId: null,
    rootId: null,
  }
}

function printSince(from: number): void {
  const sent = transport.sent.slice(from)
  for (const record of sent) {
    if (record.kind === 'card' || record.kind === 'update') {
      const card = record.card
      if (card === undefined) continue
      console.log(`  [${record.kind}] ${card.title} (${card.template})`)
      for (const line of card.lines.slice(0, 4)) console.log(`      ${line}`)
    } else {
      console.log(`  [${record.kind}] ${record.payload.replace(/\n/g, '\n      ')}`)
    }
  }
}

async function main(): Promise<void> {
  console.log(`回放目录：${workDir}（真实目录的副本，不改生产工单）`)
  console.log('调度器：假实现（模拟模型选动作），验证 Coordinator 的动作执行')
  console.log('')

  const buildingNo = seedBuildingTicket()
  const baseCount = store.all().length

  const scenarios: Array<{ text: string; expectNoNewTicket: boolean }> = [
    { text: '汇报T-0007进度', expectNoNewTicket: true },
    { text: '针对工单T-0007，汇报进度', expectNoNewTicket: true },
    { text: `汇报${buildingNo}进度`, expectNoNewTicket: true },
    { text: 'T-0007 怎么样了', expectNoNewTicket: true },
    { text: '你好', expectNoNewTicket: true },
    { text: '你是谁', expectNoNewTicket: true },
    { text: '卧槽你特么是傻逼吗', expectNoNewTicket: true },
    { text: '部署', expectNoNewTicket: true },
    { text: '怎么导出销售单', expectNoNewTicket: true },
    { text: '采购单列表页的搜索框，能不能支持按供应商名称搜索', expectNoNewTicket: false },
  ]

  let failures = 0
  for (const [index, scenario] of scenarios.entries()) {
    const before = transport.sent.length
    const countBefore = store.all().length
    const outcome = await coordinator.handle(messageFor(scenario.text, index))
    await coordinator.drain()
    const countAfter = store.all().length
    const grew = countAfter > countBefore

    console.log(`[${index + 1}] @我：${scenario.text}`)
    console.log(`    动作：${outcome.outcome} ${outcome.note ?? ''}`)
    printSince(before)
    if (grew !== !scenario.expectNoNewTicket) {
      failures += 1
      console.log(`    ✗ 建单结果不符预期：工单数 ${countBefore} → ${countAfter}`)
    }
  }

  console.log('')
  console.log(`工单数：${baseCount} → ${store.all().length}`)
  console.log(failures === 0 ? 'REPLAY_OK' : `REPLAY_FAILED（${failures} 条不符）`)
  rmSync(workDir, { recursive: true, force: true })
  if (failures > 0) process.exit(1)
}

void main()
