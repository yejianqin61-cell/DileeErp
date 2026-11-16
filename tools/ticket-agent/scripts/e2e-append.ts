/**
 * 端到端：追加需求是否走同一工单、同一会话。
 *
 * 这是「每个工单一个会话」的实证。判定看四件事：
 *   1. 第二条消息没有新建工单（`store.all()` 数量不变）；
 *   2. 第二条消息用了第一条捕获的 session id（否则上下文会丢）；
 *   3. 两轮原话都记在同一张工单里；
 *   4. 两条都跑成功。
 *
 * 注意「追加」的判定只认「回复工单卡片」，所以这里必须模拟 parentId
 * 等于第一张卡片的 message_id —— 这正是飞书在用户点「回复」时给的值。
 */

import { execFileSync } from 'node:child_process'

import { Coordinator } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { IncomingMessage } from '../src/feishu-event.ts'
import { TicketStore } from '../src/ticket-store.ts'

const REPO = process.env.DSH_REPO ?? '/opt/dilee/agent/repo'
const TICKETS = process.env.TICKETS_DIR ?? '/opt/dilee/agent/tickets'
const DSH_BIN = process.env.DSH_BIN ?? '/opt/dilee/app/node_modules/@deepseek-ai/dsh/lib/bin.js'
const NODE = process.env.DSH_NODE ?? '/opt/node24/bin/node'
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS ?? 15 * 60 * 1000)
const CHAT = 'oc_e2e_append'

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
}

function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `om_app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: CHAT,
    chatType: 'group',
    senderOpenId: 'ou_e2e_user',
    senderType: 'user',
    text,
    mentionsBot: true,
    eventId: 'ev_app',
    createTime: String(Date.now()),
    threadId: null,
    parentId: null,
    rootId: null,
    ...overrides,
  }
}

async function main(): Promise<void> {
  const before = Number(git(['rev-list', '--count', 'HEAD']))
  console.log('=== 测试前 ===')
  console.log(`  HEAD=${git(['rev-parse', '--short', 'HEAD'])} 提交数=${before}`)
  console.log()

  const transport = new FakeFeishuTransport()
  const store = new TicketStore(TICKETS)
  const ticketsBefore = store.all().filter((t) => t.chatId === CHAT).length

  // 记录每次 harness 调用收到的 sessionId，用于断言第二轮用了第一轮的 id
  const runSessions: Array<string | undefined> = []
  const { runHarness } = await import('../src/harness-runner.ts')

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: DSH_BIN,
    nodePath: NODE,
    repoPath: REPO,
    timeoutMs: TIMEOUT_MS,
    log: (line) => console.log(line),
    runHarnessImpl: async (options) => {
      runSessions.push(options.sessionId)
      return runHarness(options)
    },
  })

  console.log('=== 第一轮：新建工单 ===')
  const first = await coordinator.handle(
    message('在仓库根目录新建 AGENT_APPEND.md，内容只写一行：v1。然后 git add 并 commit，提交信息写 "test(agent): append v1"。'),
  )
  await coordinator.drain()
  console.log(`  outcome=${first.outcome} ticket=${first.ticketNo ?? '-'}`)
  console.log()

  const ticketAfterFirst = store.all().find((t) => t.chatId === CHAT)
  const cardId = ticketAfterFirst?.cardMessageId ?? null
  console.log(`  工单=${ticketAfterFirst?.no ?? '-'} 会话=${ticketAfterFirst?.sessionId ?? '-'}`)
  console.log(`  卡片 message_id=${cardId ?? '-'}`)
  console.log()

  if (cardId === null) {
    console.log('E2E_APPEND_FAIL 没有拿到卡片 message_id，无法测试追加')
    process.exitCode = 1
    return
  }

  console.log('=== 第二轮：回复卡片追加 ===')
  const second = await coordinator.handle(
    message('把 AGENT_APPEND.md 的内容改成 v2。然后 git add 并 commit，提交信息写 "test(agent): append v2"。', {
      parentId: cardId,
    }),
  )
  await coordinator.drain()
  console.log(`  outcome=${second.outcome} ticket=${second.ticketNo ?? '-'}`)
  console.log()

  const ticketsAfter = store.all().filter((t) => t.chatId === CHAT)
  const merged = ticketsAfter[0]
  const after = Number(git(['rev-list', '--count', 'HEAD']))
  const fileContent = (() => {
    try {
      return git(['show', 'HEAD:AGENT_APPEND.md'])
    } catch {
      return null
    }
  })()

  console.log('=== 结果 ===')
  console.log(`  工单数 ${ticketsBefore} → ${ticketsAfter.length}`)
  console.log(`  工单 ${merged?.no} 轮次=${merged?.turns.length} 状态=${merged?.state} 会话=${merged?.sessionId}`)
  console.log(`  harness 收到 sessionId：${JSON.stringify(runSessions)}`)
  console.log(`  提交数 ${before} → ${after}（+${after - before}）`)
  console.log(`  AGENT_APPEND.md=${JSON.stringify(fileContent)}`)
  console.log()

  const checks = [
    {
      name: '没有新建第二张工单',
      ok: ticketsAfter.length === ticketsBefore + 1,
      detail: `共 ${ticketsAfter.length} 张（期望 ${ticketsBefore + 1}）`,
    },
    {
      name: '两轮原话记在同一工单',
      ok: merged?.turns.length === 2,
      detail: `turns=${merged?.turns.length ?? 0}`,
    },
    {
      name: '第二轮续接同一会话',
      ok:
        runSessions.length === 2 &&
        runSessions[0] === undefined &&
        typeof runSessions[1] === 'string' &&
        runSessions[1] === merged?.sessionId,
      detail: `第一轮=${runSessions[0] ?? '(新)'} 第二轮=${runSessions[1] ?? '(无)'}`,
    },
    {
      name: '两轮都改了代码',
      ok: after > before,
      detail: `提交 +${after - before}`,
    },
    {
      name: '最终内容为 v2',
      ok: fileContent !== null && fileContent.includes('v2'),
      detail: fileContent ?? '(文件不存在)',
    },
    {
      name: '两轮都成功',
      ok: first.outcome === 'created' && second.outcome === 'appended',
      detail: `${first.outcome} / ${second.outcome}`,
    },
  ]

  console.log('=== 判定 ===')
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}：${check.detail}`)
  }
  const allOk = checks.every((check) => check.ok)
  console.log()
  console.log(allOk ? 'E2E_APPEND_PASS' : 'E2E_APPEND_FAIL')
  process.exitCode = allOk ? 0 : 1
}

await main()
