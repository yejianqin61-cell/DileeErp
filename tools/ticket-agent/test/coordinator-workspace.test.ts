/**
 * 端到端：真实 git 仓库 + 真实 Coordinator，验证「成功才合入、失败就丢弃」在编排层成立。
 *
 * 为什么不用假 workspace：这一层的价值全在「run 结束之后主干到底是什么状态」。
 * 假 workspace 只能证明「我调了 finishSuccess」，证明不了「main 上真的多了一个合并提交、
 * 失败单的文件真的没进主干」。临时目录 + 真 git 很便宜，能断言真结果。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Coordinator } from '../src/coordinator.ts'
import { FakeFeishuTransport } from '../src/feishu-fake.ts'
import type { IncomingMessage } from '../src/feishu-event.ts'
import type { HarnessResult } from '../src/harness-runner.ts'
import { GitWorkspace } from '../src/git-workspace.ts'
import { TicketStore } from '../src/ticket-store.ts'

const FIXED = new Date('2026-11-23T10:00:00.000Z')

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'group',
    senderOpenId: 'ou_user',
    senderType: 'user',
    text: '领料单列表加一个供应商列',
    mentionsBot: true,
    eventId: 'ev_1',
    createTime: '1763265600000',
    threadId: null,
    parentId: null,
    rootId: null,
    ...overrides,
  }
}

function setup(options: { commit: boolean; outcome: 'completed' | 'failed' }) {
  const repo = mkdtempSync(join(tmpdir(), 'dilee-ws-e2e-'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'init')

  const storeDir = mkdtempSync(join(tmpdir(), 'dilee-ws-store-'
))
  const store = new TicketStore(storeDir)
  const transport = new FakeFeishuTransport()
  const workspace = new GitWorkspace({
    repoPath: repo,
    mainBranch: 'main',
    now: () => FIXED,
  })

  const coordinator = new Coordinator({
    store,
    transport,
    dshBin: '/fake/dsh.js',
    nodePath: '/fake/node',
    repoPath: repo,
    now: () => FIXED,
    log: () => {},
    dispatchImpl: async () => ({ action: { kind: 'create_ticket' }, source: 'model' }),
    workspace,
    // 假 Agent：按需写文件并提交，然后返回指定结果。
    runHarnessImpl: async () => {
      if (options.commit) {
        writeFileSync(join(repo, 'feature.txt'), '工单产出\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-m', 'feat: 工单产出')
      }
      const result: HarnessResult = {
        outcome: options.outcome,
        sessionId: 'session-1',
        finalText: options.outcome === 'completed' ? '已完成' : '',
        events: [],
        counts: { toolCalls: 2, subagentCalls: 0, textEvents: 1 },
        exitCode: options.outcome === 'completed' ? 0 : 1,
        durationMs: 60_000,
        ...(options.outcome === 'completed' ? {} : { error: '模拟失败' }),
      }
      return result
    },
  })

  return { repo, store, transport, coordinator, cleanup: () => rmSync(repo, { recursive: true, force: true }) }
}

function mainHas(repo: string, file: string): boolean {
  try {
    git(repo, 'cat-file', '-e', `HEAD:${file}`)
    return true
  } catch {
    return false
  }
}

test('成功：改动合入主干、分支删除、卡片写明已合入', async () => {
  const ctx = setup({ commit: true, outcome: 'completed' })
  try {
    const before = git(ctx.repo, 'rev-parse', 'main')
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()

    const ticket = ctx.store.all()[0]
    assert.equal(ticket.state, 'gated', '成功单应停在待部署')
    assert.equal(ticket.branch, 'ticket/T-0001', '工单要记住自己的分支')
    assert.ok(ticket.baseSha !== null && ticket.baseSha !== undefined, '要记住基线')
    assert.equal(ticket.baseSha, before, '基线应等于开工时的 main')

    assert.equal(git(ctx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '收尾后回到主干')
    assert.equal(mainHas(ctx.repo, 'feature.txt'), true, '产出必须在主干上')
    assert.equal(git(ctx.repo, 'rev-list', '--merges', '--count', 'HEAD'), '1', '要用 --no-ff 留合并边界')
    assert.equal(git(ctx.repo, 'branch', '--list', 'ticket/T-0001'), '', '成功收尾后删分支')

    const card = ctx.transport.ofKind('update').at(-1)?.card
    assert.ok(
      card?.lines.some((line) => line.includes('已合入主干')),
      `卡片要写明合入结果：${card?.lines.join(' / ')}`,
    )
  } finally {
    ctx.cleanup()
  }
})

test('失败：分支删除、改动不进主干、主干 HEAD 一动不动', async () => {
  const ctx = setup({ commit: true, outcome: 'failed' })
  try {
    const before = git(ctx.repo, 'rev-parse', 'main')
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()

    const ticket = ctx.store.all()[0]
    assert.equal(ticket.state, 'failed')
    assert.equal(git(ctx.repo, 'rev-parse', 'main'), before, '主干不能因为失败单而前进')
    assert.equal(mainHas(ctx.repo, 'feature.txt'), false, '失败改动绝不能进主干')
    assert.equal(git(ctx.repo, 'branch', '--list', 'ticket/T-0001'), '', '失败分支要删掉')
    assert.equal(git(ctx.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')

    const card = ctx.transport.ofKind('update').at(-1)?.card
    assert.ok(card?.lines.some((line) => line.includes('未合入')), '卡片要写明未合入')
  } finally {
    ctx.cleanup()
  }
})

test('失败且留下未提交文件：stash 起来并写进工单结论，树里不留', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dilee-ws-e2e2-'))
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(repo, 'README.md'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'init')

    const storeDir = mkdtempSync(join(tmpdir(), 'dilee-ws-store-'
))
  const store = new TicketStore(storeDir)
    const transport = new FakeFeishuTransport()
    const coordinator = new Coordinator({
      store,
      transport,
      dshBin: '/x',
      nodePath: '/x',
      repoPath: repo,
      now: () => FIXED,
      log: () => {},
      dispatchImpl: async () => ({ action: { kind: 'create_ticket' }, source: 'model' }),
      workspace: new GitWorkspace({ repoPath: repo, mainBranch: 'main', now: () => FIXED }),
      // 只写文件不提交，然后失败 —— 正是 2026-11-21 事故的形状
      runHarnessImpl: async () => {
        writeFileSync(join(repo, 'draft.txt'), '改到一半的草稿\n')
        return {
          outcome: 'failed',
          sessionId: null,
          finalText: '',
          events: [],
          counts: { toolCalls: 1, subagentCalls: 0, textEvents: 0 },
          exitCode: 1,
          durationMs: 1000,
          error: '模拟失败',
        }
      },
    })

    await coordinator.handle(message())
    await coordinator.drain()

    const ticket = store.all()[0]
    assert.equal(ticket.state, 'failed')
    assert.ok(ticket.stashRef !== null && ticket.stashRef !== undefined, '残留必须 stash 并记进工单')
    assert.match(String(ticket.stashRef), /stash@\{0\}/)
    assert.equal(git(repo, 'status', '--porcelain'), '', '收尾后工作区必须干净')
    assert.equal(git(repo, 'stash', 'list').includes('T-0001-failed-residue'), true)
    assert.match(ticket.result?.summary ?? '', /残留已暂存为/, '结论里要写明 stash ref')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('部署预检：停在工单分支上拒绝部署', async () => {
  const ctx = setup({ commit: true, outcome: 'completed' })
  try {
    // 模拟「人还站在工单分支上」：直接切回去
    git(ctx.repo, 'checkout', '-b', 'ticket/T-9999')
    const { runDeploy, defaultDeployTimeouts } = await import('../src/deploy.ts')
    // 注入一个「真跑 git」的执行器：默认执行器会把 PATH 换成部署用的固定值，
    // 在测试机上找不到 git。这里只用到 git，等价且更真实。
    const realRunner = async (input: {
      command: string
      args: readonly string[]
      cwd?: string
    }): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const stdout = execFileSync(input.command, [...input.args], {
          cwd: input.cwd,
          env: GIT_ENV,
          encoding: 'utf8',
        })
        return { code: 0, stdout, stderr: '' }
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string }
        return {
          code: failure.status ?? 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? String(error),
        }
      }
    }
    const result = await runDeploy({
      config: {
        repoPath: ctx.repo,
        rootDir: join(ctx.repo, 'root'),
        appDir: join(ctx.repo, 'app'),
        workDir: join(ctx.repo, 'work'),
        archivePath: join(ctx.repo, 'a.tar.gz'),
        recordsDir: join(ctx.repo, 'deploys'),
        gitRemote: 'origin',
        gitBranch: 'main',
        keepBackups: 3,
        requirePush: false,
        skipTests: false,
        minFreeGb: 1,
        mainBranch: 'main',
        timeouts: defaultDeployTimeouts(),
        runner: realRunner,
        log: () => {},
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'preflight')
    assert.match(result.failure ?? '', /不是主干/)
  } finally {
    ctx.cleanup()
  }
})

test('git 仓库的 README 未被误改（分支操作不碰无关文件）', async () => {
  const ctx = setup({ commit: true, outcome: 'completed' })
  try {
    await ctx.coordinator.handle(message())
    await ctx.coordinator.drain()
    assert.equal(readFileSync(join(ctx.repo, 'README.md'), 'utf8'), 'base\n')
  } finally {
    ctx.cleanup()
  }
})
