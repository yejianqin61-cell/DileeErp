/**
 * 端到端冒烟：从「一句口语需求」到「Harness 真改代码」。
 *
 * 不经过飞书：直接调 Coordinator 处理一条构造好的消息。
 * 这样能把「飞书传输」与「编排 + Harness」分开验证 ——
 * 飞书那层已有 54 条测试覆盖，这里验的是后半段。
 *
 * 判定看三件事：
 *   1. 是否捕获到 session id（会话成立）；
 *   2. 工作区提交数是否增加（真的改了代码）；
 *   3. 卡片是否 green 且带结论。
 *
 * 结果按 PASS/FAIL 输出，并带具体数字，便于写进日志。
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
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS ?? 20 * 60 * 1000)

function commitCount(): number {
  return Number(execFileSync('git', ['-C', REPO, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim())
}

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
}

function message(text: string): IncomingMessage {
  return {
    messageId: `om_e2e_${Date.now()}`,
    chatId: 'oc_e2e_test',
    chatType: 'group',
    senderOpenId: 'ou_e2e_user',
    senderType: 'user',
    text,
    mentionsBot: true,
    eventId: 'ev_e2e',
    createTime: String(Date.now()),
    threadId: null,
    parentId: null,
    rootId: null,
  }
}

async function main(): Promise<void> {
  const before = commitCount()
  console.log('=== 测试前 ===')
  console.log(`  分支=${git(['rev-parse', '--abbrev-ref', 'HEAD'])} 提交数=${before}`)
  console.log(`  HEAD=${git(['rev-parse', '--short', 'HEAD'])}`)
  console.log(`  工作区：${git(['status', '--porcelain']).length === 0 ? '干净' : '有未提交改动'}`)
  console.log()

  const transport = new FakeFeishuTransport()
  const store = new TicketStore(TICKETS)
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: DSH_BIN,
    nodePath: NODE,
    repoPath: REPO,
    timeoutMs: TIMEOUT_MS,
    log: (line) => console.log(line),
  })

  const text =
    '在仓库根目录新建一个文件 AGENT_SMOKE.md，内容只写一行：agent e2e ok。' +
    '然后 git add 并 commit，提交信息写 "test(agent): e2e smoke"。不要改其他任何文件。'

  console.log('=== 提交给 Coordinator ===')
  console.log(`  ${text}`)
  console.log()

  const outcome = await coordinator.handle(message(text))
  console.log(`handle outcome=${JSON.stringify(outcome)}`)
  console.log('=== 等待串行队列 ===')
  await coordinator.drain()
  console.log('队列已排空')
  console.log()

  const tickets = store.all().filter((ticket) => ticket.chatId === 'oc_e2e_test')
  const latest = tickets[tickets.length - 1]
  console.log('=== 工单 ===')
  console.log(`  ${latest?.no ?? '(无)'} 状态=${latest?.state ?? '?'} 会话=${latest?.sessionId ?? '(无)'}`)

  console.log('=== 飞书侧收到的内容 ===')
  for (const record of transport.sent) {
    console.log(`  [${record.kind}] ${record.payload.slice(0, 100)}`)
    if (record.card) {
      console.log(`    template=${record.card.template}`)
      for (const line of record.card.lines) console.log(`    | ${line.slice(0, 160)}`)
    }
  }
  console.log()

  const after = commitCount()
  const newFile = (() => {
    try {
      return git(['show', 'HEAD:AGENT_SMOKE.md'])
    } catch {
      return null
    }
  })()

  console.log('=== 测试后 ===')
  console.log(`  提交数 ${before} → ${after}（+${after - before}）`)
  console.log(`  HEAD=${git(['rev-parse', '--short', 'HEAD'])}`)
  console.log(`  AGENT_SMOKE.md：${newFile === null ? '(不存在)' : JSON.stringify(newFile)}`)
  console.log(`  工作区：${git(['status', '--porcelain']).length === 0 ? '干净' : '有未提交改动'}`)
  console.log()

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: '会话成立',
      ok: typeof latest?.sessionId === 'string' && latest.sessionId.length > 0,
      detail: latest?.sessionId ?? '无 session id',
    },
    {
      name: '代码有改动',
      ok: after > before,
      detail: `提交数 +${after - before}`,
    },
    {
      name: '产出文件正确',
      ok: newFile !== null && newFile.includes('agent e2e ok'),
      detail: newFile === null ? '文件不存在' : '内容匹配',
    },
    {
      name: '卡片为成功态',
      ok: transport.sent.some((record) => record.card?.template === 'green'),
      detail: '应出现 green 卡片',
    },
  ]

  console.log('=== 判定 ===')
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}：${check.detail}`)
  }
  const allOk = checks.every((check) => check.ok)
  console.log()
  console.log(allOk ? 'E2E_PASS' : 'E2E_FAIL')
  process.exitCode = allOk ? 0 : 1
}

await main()
