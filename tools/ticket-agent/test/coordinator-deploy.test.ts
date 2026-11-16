import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Coordinator } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { IncomingMessage } from '../src/feishu-event.ts'
import type { HarnessResult } from '../src/harness-runner.ts'
import { defaultDeployTimeouts, type DeployConfig, type DeployResult } from '../src/deploy.ts'
import { TicketStore } from '../src/ticket-store.ts'

const FIXED = new Date('2026-11-16T06:00:00.000Z')
const RELEASE = 'c'.repeat(40)
const PREV = 'b'.repeat(40)

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderType: 'user',
    text: '部署',
    mentionsBot: true,
    eventId: 'ev_1',
    createTime: '1763272800000',
    threadId: null,
    parentId: null,
    rootId: null,
    ...overrides,
  }
}

function harnessOk(): HarnessResult {
  return {
    outcome: 'completed',
    sessionId: 'session-1',
    finalText: '已修复。',
    events: [],
    counts: { toolCalls: 3, subagentCalls: 0, textEvents: 1 },
    exitCode: 0,
    durationMs: 60_000,
  }
}

function deployResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return {
    ok: true,
    pushed: true,
    rolledBack: false,
    release: RELEASE,
    previousVersion: PREV,
    backupDir: '/opt/dilee/app.backup-20261116-140000',
    phase: 'done',
    failure: null,
    warning: null,
    startedAt: '2026-11-16T06:00:00.000Z',
    finishedAt: '2026-11-16T06:25:00.000Z',
    durationMs: 25 * 60_000,
    ...overrides,
  }
}

function deployConfig(): DeployConfig {
  return {
    repoPath: '/opt/dilee/agent/repo',
    rootDir: '/opt/dilee',
    appDir: '/opt/dilee/app',
    workDir: '/tmp/dilee-deploy',
    archivePath: '/tmp/dilee-agent-release.tar.gz',
    recordsDir: '/opt/dilee/agent/deploys',
    gitRemote: 'origin',
    gitBranch: 'main',
    keepBackups: 3,
    requirePush: true,
    skipTests: false,
    minFreeGb: 5,
    timeouts: defaultDeployTimeouts(),
  }
}

function setup(options: {
  autoDeploy?: boolean
  deployEnabled?: boolean
  result?: DeployResult
  runResult?: HarnessResult
  deployThrows?: boolean
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-coord-deploy-'))
  const store = new TicketStore(dir)
  const transport = new FakeFeishuTransport()
  const deployCalls: unknown[] = []
  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/fake/dsh.js',
    nodePath: '/fake/node',
    repoPath: '/fake/repo',
    now: () => FIXED,
    log: () => {},
    runHarnessImpl: async () => options.runResult ?? harnessOk(),
    answererKey: '',
    answererImpl: async () => ({ text: 'x', source: 'model' }),
    progressNoticeMs: 0,
    cardUpdateMs: -1,
    deployConfig: options.deployEnabled === false ? null : deployConfig(),
    deployImpl: async (input) => {
      deployCalls.push(input)
      if (options.deployThrows === true) throw new Error('spawn ENOENT')
      return options.result ?? deployResult()
    },
    autoDeploy: options.autoDeploy ?? false,
  })
  return { dir, store, transport, deployCalls, coordinator }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function gatedTicket(store: TicketStore): string {
  const ticket = store.create({
    messageId: 'om_ticket',
    chatId: 'oc_1',
    text: '采购单列表加一列供应商',
    at: FIXED.toISOString(),
    state: 'gated',
  })
  store.bindCard(ticket.id, 'om_card_1', FIXED.toISOString())
  return ticket.no
}

test('群里说「部署」：执行部署，工单上线并出绿卡', async () => {
  const { dir, store, transport, deployCalls, coordinator } = setup()
  try {
    const ticketNo = gatedTicket(store)
    const outcome = await coordinator.handle(message())
    await coordinator.drain()

    assert.equal(outcome.outcome, 'answered')
    assert.equal(outcome.note, 'deploy:command')
    assert.equal(deployCalls.length, 1)
    assert.equal(store.all()[0].state, 'done')

    const replies = transport.ofKind('reply').map((record) => record.payload)
    assert.ok(replies.some((text) => text.includes('开始部署')))
    assert.ok(replies.some((text) => text.includes(`${ticketNo} 已上线`)))

    const lastUpdate = transport.ofKind('update').at(-1)
    assert.equal(lastUpdate?.card?.title, `已上线｜${ticketNo}`)
    assert.equal(lastUpdate?.card?.template, 'green')
    assert.ok(lastUpdate?.card?.lines.some((line) => line.includes(RELEASE.slice(0, 8))))
  } finally {
    cleanup(dir)
  }
})

test('没有待部署工单：不执行部署，直接说清楚', async () => {
  const { dir, transport, deployCalls, coordinator } = setup()
  try {
    await coordinator.handle(message())
    await coordinator.drain()
    assert.equal(deployCalls.length, 0)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /没有待部署的改动/)
  } finally {
    cleanup(dir)
  }
})

test('部署未配置：如实说没配置，不假装执行', async () => {
  const { dir, store, transport, deployCalls, coordinator } = setup({ deployEnabled: false })
  try {
    store.create({ messageId: 'om_x', chatId: 'oc_1', text: '需求', at: FIXED.toISOString(), state: 'gated' })
    await coordinator.handle(message())
    await coordinator.drain()
    assert.equal(deployCalls.length, 0)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /没有配置部署能力/)
  } finally {
    cleanup(dir)
  }
})

test('部署失败（切换前）：工单回 gated，红卡写明阶段与原因', async () => {
  const { dir, store, transport, coordinator } = setup({
    result: deployResult({
      ok: false,
      pushed: true,
      rolledBack: false,
      phase: 'build',
      failure: '构建失败：API 构建退出码 1',
      durationMs: 9 * 60_000,
    }),
  })
  try {
    gatedTicket(store)
    await coordinator.handle(message())
    await coordinator.drain()

    assert.equal(store.all()[0].state, 'gated')
    const lastUpdate = transport.ofKind('update').at(-1)
    assert.equal(lastUpdate?.card?.template, 'red')
    assert.match(lastUpdate?.card?.title ?? '', /部署失败/)
    assert.ok(lastUpdate?.card?.lines.some((line) => line.includes('构建')))
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /部署失败/)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /线上未切换/)
  } finally {
    cleanup(dir)
  }
})

test('部署失败但已自动回滚：工单 rolled_back，紫卡', async () => {
  const { dir, store, transport, coordinator } = setup({
    result: deployResult({
      ok: false,
      rolledBack: true,
      phase: 'rolled-back',
      failure: '核验失败：登录页 502（已自动回滚）',
    }),
  })
  try {
    gatedTicket(store)
    await coordinator.handle(message())
    await coordinator.drain()

    assert.equal(store.all()[0].state, 'rolled_back')
    const lastUpdate = transport.ofKind('update').at(-1)
    assert.equal(lastUpdate?.card?.template, 'purple')
    assert.match(lastUpdate?.card?.title ?? '', /已回滚/)
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /已自动回滚/)
  } finally {
    cleanup(dir)
  }
})

test('自动部署：run 成功后自动排队部署，工单直接上线', async () => {
  const { dir, store, transport, deployCalls, coordinator } = setup({ autoDeploy: true })
  try {
    await coordinator.handle(
      message({ messageId: 'om_req', text: '采购单列表页的搜索框，希望能按供应商名称搜' }),
    )
    await coordinator.drain()

    assert.equal(deployCalls.length, 1)
    assert.equal(store.all()[0].state, 'done')
    const replies = transport.ofKind('reply').map((record) => record.payload)
    assert.ok(replies.some((text) => text.includes('开始部署')))
    assert.ok(replies.some((text) => text.includes('已上线')))
  } finally {
    cleanup(dir)
  }
})

test('部署器自己抛异常：工单回到 gated，不永远卡在 deploying', async () => {
  const { dir, store, transport, coordinator } = setup({ deployThrows: true })
  try {
    gatedTicket(store)
    await coordinator.handle(message())
    await coordinator.drain()
    assert.equal(store.all()[0].state, 'gated')
    const lastUpdate = transport.ofKind('update').at(-1)
    assert.equal(lastUpdate?.card?.template, 'red')
    assert.match(transport.ofKind('reply').at(-1)?.payload ?? '', /部署失败/)
  } finally {
    cleanup(dir)
  }
})

test('autoDeploy=false：run 成功后不自动部署，停在 gated', async () => {
  const { dir, store, deployCalls, coordinator } = setup({ autoDeploy: false })
  try {
    await coordinator.handle(
      message({ messageId: 'om_req', text: '采购单列表页的搜索框，希望能按供应商名称搜' }),
    )
    await coordinator.drain()
    assert.equal(deployCalls.length, 0)
    assert.equal(store.all()[0].state, 'gated')
  } finally {
    cleanup(dir)
  }
})
