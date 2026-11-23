/**
 * git-workspace 的测试**用真 git 跑真仓库**，不用假执行器。
 *
 * 为什么不用 mock：这一层的全部价值就是「git 命令按这个顺序执行会产生什么结果」。
 * 假执行器只能验证「我以为是这么调用的」，验证不了「合入后主干真的干净、失败后分支真的没了」。
 * 一个临时目录 + 几条真命令，比任何 mock 都便宜且可信。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GitWorkspace, branchFor } from '../src/git-workspace.ts'

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

/** 造一个只有一个提交的临时仓库。 */
function makeRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-ws-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeWorkspace(dir: string, logs: string[] = []): GitWorkspace {
  return new GitWorkspace({
    repoPath: dir,
    mainBranch: 'main',
    log: (line) => logs.push(line),
    now: () => new Date('2026-11-23T10:00:00.000Z'),
  })
}

function writeAndCommit(dir: string, name: string, content: string, message: string): void {
  writeFileSync(join(dir, name), content)
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', message)
}

/** 某个 rev 是否存在（`rev-parse --verify --quiet` 不存在时退出码非 0）。 */
function revExists(cwd: string, rev: string): boolean {
  try {
    git(cwd, 'rev-parse', '--verify', '--quiet', rev)
    return true
  } catch {
    return false
  }
}

/** 某个 rev 下是否有这个文件。 */
function revHas(cwd: string, rev: string, file: string): boolean {
  try {
    git(cwd, 'cat-file', '-e', `${rev}:${file}`)
    return true
  } catch {
    return false
  }
}

test('分支名：票号折成 ticket/T-00XX，非法字符替换掉', () => {
  assert.equal(branchFor('T-0027'), 'ticket/T-0027')
  assert.equal(branchFor('T 0027/x'), 'ticket/T-0027-x')
})

test('开工：从主干拉出工单分支，并记下基线', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    const baseSha = git(repo.dir, 'rev-parse', 'main')

    const begun = await ws.begin('T-0027')

    assert.equal(begun.branch, 'ticket/T-0027')
    assert.equal(begun.baseSha, baseSha)
    assert.equal(begun.stashedBefore, null, '干净工作区不该造 stash')
    assert.equal(await ws.currentBranch(), 'ticket/T-0027', '开工后应在工单分支上')
    assert.equal(git(repo.dir, 'rev-parse', 'main'), baseSha, 'main 不应被动过')
  } finally {
    repo.cleanup()
  }
})

test('开工前工作区是脏的：先 stash，再拉分支（不让残留带上车）', async () => {
  const repo = makeRepo()
  try {
    writeFileSync(join(repo.dir, 'leftover.txt'), '上一个单留下的\n')
    writeFileSync(join(repo.dir, 'README.md'), 'base\n被改过的\n')

    const ws = makeWorkspace(repo.dir)
    const begun = await ws.begin('T-0028')

    assert.ok(begun.stashedBefore !== null, '脏文件必须被 stash')
    assert.match(begun.stashedBefore, /stash@\{0\}/)
    assert.equal(await ws.isDirty(), false, 'stash 之后工作区必须干净')
    assert.equal(
      git(repo.dir, 'stash', 'list').includes('residue-before-T-0028'),
      true,
      'stash 消息要能追溯到工单',
    )
    assert.match(git(repo.dir, 'branch', '--list', 'ticket/*'), /ticket\/T-0028/)
  } finally {
    repo.cleanup()
  }
})

test('成功收尾：--no-ff 合入主干，分支删除，工作区回到 main', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    await ws.begin('T-0029')
    writeAndCommit(repo.dir, 'feature.txt', '新功能\n', 'feat: T-0029 新功能')

    const finish = await ws.finishSuccess('T-0029')

    assert.equal(finish.merged, true, finish.detail)
    assert.equal(finish.conflict, false)
    assert.equal(finish.stashed, null)
    assert.equal(finish.autoCommitted, null, '工作区本来就干净，不该多出自动提交')
    assert.equal(finish.mergedCommits, 1, '合进来的就是那一笔工单提交')
    assert.ok(finish.mergedSha !== null)
    assert.match(finish.detail, /已合入 main（1 个提交，至 /, 'detail 要带提交数与短 sha')
    assert.equal(await ws.currentBranch(), 'main', '收尾后必须回到主干')
    assert.equal(readFileSync(join(repo.dir, 'feature.txt'), 'utf8'), '新功能\n', '改动应在主干上')
    assert.equal(git(repo.dir, 'branch', '--list', 'ticket/T-0029'), '', '分支应被删除')
    // --no-ff 的证据：HEAD 是一个合并提交，且真的有两个父（不是快进）
    assert.equal(git(repo.dir, 'rev-list', '--merges', '--count', 'HEAD'), '1')
    assert.match(git(repo.dir, 'log', '-1', '--format=%s'), /merge\(T-0029\)/)
    assert.equal(revExists(repo.dir, 'HEAD^2'), true, '--no-ff 必须留下第二父（工单分支 tip）')
  } finally {
    repo.cleanup()
  }
})

test('成功但工作区有未提交改动、分支上还没有提交：自动提交到工单分支后再合入，产出不丢', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    const before = git(repo.dir, 'rev-parse', 'main')
    await ws.begin('T-0030')
    // 关键：改完不提交 —— 这正是 T-0027 的形状（43 分钟的产出全躺在工作区里）
    writeFileSync(join(repo.dir, 'done.txt'), '43 分钟的产出\n')

    const finish = await ws.finishSuccess('T-0030')

    assert.equal(finish.merged, true, finish.detail)
    assert.ok(finish.mergedCommits >= 1, `至少要合入自动提交那一笔：${String(finish.mergedCommits)}`)
    assert.ok(finish.autoCommitted !== null, '收尾必须在工单分支上真的落一个提交')
    assert.equal(finish.stashed, null, '有提交就不该再把产出推进 stash')
    assert.notEqual(git(repo.dir, 'rev-parse', 'main'), before, '主干必须真的前进')
    assert.equal(revHas(repo.dir, 'HEAD', 'done.txt'), true, '产出必须在主干上')
    assert.equal(readFileSync(join(repo.dir, 'done.txt'), 'utf8'), '43 分钟的产出\n')
    // 「提交 → 审阅 → 门禁」没被绕过：产出是一笔署了票号的提交，再由 merge 节点收进来
    assert.match(
      git(repo.dir, 'log', '--format=%s'),
      /ticket\(T-0030\): 工单产出（收尾自动提交）/,
      '产出提交要能追溯到工单',
    )
    assert.equal(git(repo.dir, 'branch', '--list', 'ticket/T-0030'), '', '合入后删分支')
    assert.equal(await ws.isDirty(), false, '收尾后工作区必须干净')
  } finally {
    repo.cleanup()
  }
})

test('成功但本单完全没改动：不合入、不谎报，detail 写明主干未变', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    const before = git(repo.dir, 'rev-parse', 'main')
    await ws.begin('T-0036')

    const finish = await ws.finishSuccess('T-0036')

    assert.equal(finish.merged, false, '一个字节都没进主干，就不能说「已合入」')
    assert.equal(finish.mergedSha, null)
    assert.equal(finish.mergedCommits, 0)
    assert.equal(finish.conflict, false, '零提交不是冲突')
    assert.match(finish.detail, /主干未变/, 'detail 必须说清真相')
    assert.equal(git(repo.dir, 'rev-parse', 'main'), before, '主干必须一动不动')
    assert.equal(git(repo.dir, 'rev-list', '--merges', '--count', 'HEAD'), '0', '不该造空合并提交')
    assert.equal(git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  } finally {
    repo.cleanup()
  }
})

test('失败收尾：分支删除、改动丢弃、主干 HEAD 不变，但已提交的改动留 tag 作证', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    const before = git(repo.dir, 'rev-parse', 'main')
    await ws.begin('T-0031')
    writeAndCommit(repo.dir, 'bad.txt', '失败的实现\n', 'wip: T-0031 失败实现')
    const tip = git(repo.dir, 'rev-parse', 'ticket/T-0031')

    const finish = await ws.finishFailure('T-0031')

    assert.equal(finish.merged, false)
    // 不合并 ≠ 销毁现场：分支删了，但 tip 必须还找得回来
    const tag = finish.abandonedTag
    assert.ok(tag !== null, '分支上有提交就必须打 tag 留证')
    assert.equal(tag, 'abandoned/T-0031-20261123T100000Z', 'tag 名带票号与 UTC 时间戳')
    assert.equal(git(repo.dir, 'rev-parse', tag), tip, 'tag 必须指在原分支 tip 上')
    assert.equal(revHas(repo.dir, tag, 'bad.txt'), true, '现场内容仍能从 tag 读出')
    assert.match(finish.detail, /abandoned\/T-0031-20261123T100000Z/, 'detail 要写明 tag')
    assert.match(finish.detail, /已丢弃分支 ticket\/T-0031/)
    assert.equal(await ws.currentBranch(), 'main')
    assert.equal(git(repo.dir, 'rev-parse', 'main'), before, '主干必须一动不动')
    assert.equal(git(repo.dir, 'branch', '--list', 'ticket/T-0031'), '', '失败分支要删掉')
    assert.equal(revHas(repo.dir, 'HEAD', 'bad.txt'), false, '失败改动不能进主干')
  } finally {
    repo.cleanup()
  }
})

test('失败且分支上没有提交：删分支、不产生留证 tag', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    await ws.begin('T-0037')
    // 只写不提交：分支 tip 仍等于基线，没有现场可留
    writeFileSync(join(repo.dir, 'draft.txt'), '草稿\n')

    const finish = await ws.finishFailure('T-0037')

    assert.equal(finish.merged, false)
    assert.equal(finish.abandonedTag, null, '没有提交就没有现场可留，不该造 tag')
    assert.equal(git(repo.dir, 'tag', '--list', 'abandoned/*'), '', '不该出现任何留证 tag')
    assert.equal(git(repo.dir, 'branch', '--list', 'ticket/T-0037'), '', '分支要删掉')
    assert.equal(finish.stashed !== null, true, '未提交残留照旧进 stash')
    assert.match(finish.detail, /无提交产出/)
  } finally {
    repo.cleanup()
  }
})

test('失败且工作区脏：残留 stash 起来，主干干净', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    await ws.begin('T-0032')
    writeAndCommit(repo.dir, 'partial.txt', '改到一半\n', 'wip: T-0032')
    writeFileSync(join(repo.dir, 'rough.txt'), '没提交的草稿\n')

    const finish = await ws.finishFailure('T-0032')

    assert.equal(finish.merged, false)
    assert.ok(finish.stashed !== null, '残留要 stash，不能留在树里')
    assert.equal(await ws.isDirty(), false, '收尾后工作区必须干净')
    assert.equal(git(repo.dir, 'stash', 'list').includes('T-0032-failed-residue'), true)
  } finally {
    repo.cleanup()
  }
})

test('合入冲突：中止合并、保留分支、回到主干，绝不自动解', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    await ws.begin('T-0033')
    // 工单分支改 README
    writeAndCommit(repo.dir, 'README.md', 'base\n工单改成这样\n', 'feat: T-0033')
    // 主干上也改同一处（模拟别的单先合入）
    git(repo.dir, 'checkout', 'main')
    writeAndCommit(repo.dir, 'README.md', 'base\n主干改成那样\n', 'feat: 另一张单')
    git(repo.dir, 'checkout', 'ticket/T-0033')

    const finish = await ws.finishSuccess('T-0033')

    assert.equal(finish.merged, false)
    assert.equal(finish.conflict, true, finish.detail)
    assert.match(finish.detail, /冲突/)
    assert.equal(await ws.currentBranch(), 'main', '冲突后要回到主干，不留半合并状态')
    assert.match(git(repo.dir, 'branch', '--list', 'ticket/T-0033'), /T-0033/, '冲突时保留分支待人工处理')
    assert.equal(git(repo.dir, 'rev-list', '--merges', '--count', 'HEAD'), '0', '不该产生合并提交')
    assert.equal(readFileSync(join(repo.dir, 'README.md'), 'utf8'), 'base\n主干改成那样\n', '主干保持自己的版本')
  } finally {
    repo.cleanup()
  }
})

test('启动恢复：停在工单分支 + 留脏 → stash、回主干、删分支', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    await ws.begin('T-0034')
    writeAndCommit(repo.dir, 'x.txt', '中断前的提交\n', 'wip: T-0034')
    writeFileSync(join(repo.dir, 'y.txt'), '中断前的草稿\n')

    const recovered = await ws.recover()

    assert.equal(recovered.recoveredBranch, 'ticket/T-0034')
    assert.equal(await ws.currentBranch(), 'main')
    assert.equal(await ws.isDirty(), false)
    assert.equal(git(repo.dir, 'branch', '--list', 'ticket/T-0034'), '', '中断分支要删掉')
    assert.equal(git(repo.dir, 'stash', 'list').includes('stale-on-startup'), true)
  } finally {
    repo.cleanup()
  }
})

test('启动恢复：本来就在主干上什么都不做', async () => {
  const repo = makeRepo()
  try {
    const ws = makeWorkspace(repo.dir)
    const recovered = await ws.recover()
    assert.equal(recovered.recoveredBranch, null)
    assert.equal(recovered.leftoverBranches.length, 0)
    assert.equal(await ws.currentBranch(), 'main')
  } finally {
    repo.cleanup()
  }
})

test('同名残留分支：开工时先删掉，从主干重新拉', async () => {
  const repo = makeRepo()
  try {
    // 伪造一条上次没收拾干净的 T-0035 分支
    git(repo.dir, 'checkout', '-b', 'ticket/T-0035')
    writeAndCommit(repo.dir, 'junk.txt', '上次的垃圾\n', 'wip: 残留')
    git(repo.dir, 'checkout', 'main')

    const ws = makeWorkspace(repo.dir)
    const begun = await ws.begin('T-0035')

    assert.equal(begun.branch, 'ticket/T-0035')
    let present = true
    try {
      git(repo.dir, 'cat-file', '-e', 'HEAD:junk.txt')
    } catch {
      present = false
    }
    assert.equal(present, false, '残留内容不能跟着新分支回来')
  } finally {
    repo.cleanup()
  }
})
