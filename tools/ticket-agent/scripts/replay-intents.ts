/**
 * 用**真实工单目录**回放一组 @ 消息，检查意图路由与进度回答。
 *
 * 为什么不连真飞书：我们要验证的是「收到这句话之后会怎么答」，
 * 飞书只负责把消息送到（已单独验证）。用假传输能稳定看到每条回复全文，也敢在
 * 生产工单目录的副本上跑。
 *
 * 为什么要跑真模型：提问路径就是模型调用，假模型只能证明代码通，不能证明答案像人话。
 * 没有 DEEPSEEK_API_KEY 时会走兜底话术，脚本照常通过但会标注。
 *
 * 用法：
 *   node --import tsx scripts/replay-intents.ts /opt/dilee/agent/tickets
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Coordinator } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { HarnessEvent, HarnessResult } from '../src/harness-runner.ts'
import { TicketStore } from '../src/ticket-store.ts'

const sourceDir = process.argv[2] ?? '/opt/dilee/agent/tickets'
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? ''

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

const coordinator = new Coordinator({
  store,
  transport,
  dshBin: '/fake/dsh.js',
  nodePath: '/fake/node',
  repoPath: '/fake/repo',
  log: (line) => console.log(`  · ${line}`),
  answererKey: apiKey,
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
  console.log(apiKey.length > 0 ? '问答模型：真调用 DeepSeek' : '问答模型：未配置密钥，将走兜底话术')
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
    console.log(`    意图：${outcome.outcome} ${outcome.note ?? ''}`)
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
