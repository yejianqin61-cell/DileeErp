/**
 * 用**真实 DeepSeek** 走一遍调度器：验证函数调用能不能用，以及模型会把常见话术
 * 判成什么动作。这是这次改造唯一的未知项 —— 假模型只能证明代码通。
 *
 * 用法：/opt/node24/bin/node --import tsx scripts/probe-dispatch.ts
 */

import { readFileSync } from 'node:fs'

import { dispatch, type DispatchInput } from '../src/dispatcher.ts'
import { TicketStore } from '../src/ticket-store.ts'

const ENV_FILE = process.env.ENV_FILE ?? '/opt/dilee/agent/ticket-agent/.env'

function loadEnvFile(path: string): void {
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    console.log(`（读不到 ${path}，用当前环境变量）`)
    return
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#') || !line.includes('=')) continue
    const at = line.indexOf('=')
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '')
    if (key.length > 0 && process.env[key] === undefined) process.env[key] = value
  }
}

const CASES: Array<{ text: string; expect: string[] }> = [
  { text: '采购单列表页的搜索框，希望能按供应商名称搜', expect: ['create_ticket'] },
  { text: '再次尝试部署', expect: ['deploy'] },
  { text: '麻烦部署一下', expect: ['deploy'] },
  { text: '汇报 T-0022 的进度', expect: ['status'] },
  { text: 'T-0023 怎么样了', expect: ['status'] },
  { text: '你好', expect: ['reply'] },
  { text: '你是哪位', expect: ['reply'] },
  { text: '卧槽你特么是傻逼吗', expect: ['reply'] },
  { text: '这个不对', expect: ['ask_more_info', 'reply'] },
  { text: '有问题', expect: ['ask_more_info', 'reply'] },
  { text: '怎么导出销售单', expect: ['reply'] },
  // 下面两条是「说出了具体位置但没有期望」：必须建单，不能追问
  { text: '部署脚本要改，别每次都失败', expect: ['create_ticket'] },
  { text: '首页任务提醒面板的任务点进去跳转错了', expect: ['create_ticket'] },
  // 这条和 T-0023（领料单打印规格型号）是同一件事：建单或追加都算对，不该重复开单
  { text: '领料单打印出来的规格型号带了个备注，太长了', expect: ['create_ticket', 'append_ticket'] },
]

async function main(): Promise<void> {
  loadEnvFile(ENV_FILE)
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? ''
  if (apiKey.length === 0) {
    console.error('缺少 DEEPSEEK_API_KEY')
    process.exit(2)
  }

  const store = new TicketStore(process.env.TICKETS_DIR?.trim() || '/opt/dilee/agent/tickets')
  const tickets = store.all()
  const gated = tickets.filter((ticket) => ticket.state === 'gated').map((ticket) => ticket.no)

  const base: DispatchInput = {
    text: '',
    tickets: tickets.slice(-12).map((ticket) => ({
      no: ticket.no,
      state: ticket.state,
      head: (ticket.turns[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 50),
      elapsedMs: null,
    })),
    activeCount: tickets.filter((t) => t.state === 'queued' || t.state === 'building').length,
    gated,
    deployEnabled: true,
    replyingToTicketNo: null,
  }

  console.log(`工单 ${tickets.length} 张；待部署 ${gated.join('、') || '无'}`)
  console.log('')

  let failures = 0
  for (const [index, item] of CASES.entries()) {
    const startedAt = Date.now()
    const result = await dispatch({ ...base, text: item.text }, { apiKey, log: () => {} })
    const elapsed = Date.now() - startedAt
    const action = result.action
    const detail =
      action.kind === 'append_ticket' || action.kind === 'start_run'
        ? ` ticketNo=${action.ticketNo}`
        : action.kind === 'reply'
          ? ` text=${action.text.slice(0, 40)}`
          : action.kind === 'status'
            ? ` ticketNo=${action.ticketNo ?? '(全局)'}`
            : action.kind === 'ask_more_info'
              ? ` q=${action.question.slice(0, 30)}`
              : ''
    const ok = item.expect.includes(action.kind)
    if (!ok) failures += 1
    console.log(`${ok ? '✔' : '✘'} [${index + 1}] ${item.text}`)
    console.log(`     → ${action.kind}${detail}`)
    console.log(`     source=${result.source}${result.error === undefined ? '' : ` error=${result.error}`} ${elapsed}ms`)
  }

  console.log('')
  console.log(failures === 0 ? 'DISPATCH_PROBE_OK' : `DISPATCH_PROBE_FAILED（${failures} 条不符预期）`)
  if (failures > 0) process.exit(1)
}

void main()