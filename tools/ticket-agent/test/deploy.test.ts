import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  countMigrationDirs,
  defaultDeployTimeouts,
  runDeploy,
  shortVersion,
  type CommandInput,
  type CommandResult,
  type CommandRunner,
  type DeployConfig,
  type DeployResult,
} from '../src/deploy.ts'

const HEAD = 'a'.repeat(40)
const PREV = 'b'.repeat(40)
const REMOTE = HEAD

interface FakeOptions {
  status?: string
  head?: string
  prev?: string
  liveAfterSwitch?: string | null
  applied?: number
  failed?: number
  repoMigrations?: number
  diskKb?: number
  ancestorCode?: number
  ffCode?: number
  fetchCode?: number
  pushCode?: number
  pushOut?: string
  buildCode?: number
  buildOut?: string
  testCode?: number
  migrateCode?: number
  testOut?: string
  switchCode?: number
  switchWritesRelease?: boolean
  verifyCode?: number
  edgeCode?: number
  rollbackCode?: number
  requirePush?: boolean
  skipTests?: boolean
  reuseStaging?: boolean
}

interface Harness {
  root: string
  config: DeployConfig
  calls: CommandInput[]
  phases: string[]
  cleanup: () => void
  releaseFile: string
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })

function setup(options: FakeOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dilee-deploy-test-'))
  const repo = join(root, 'repo')
  const migrations = join(repo, 'apps/api/prisma/migrations')
  mkdirSync(migrations, { recursive: true })
  const migrationCount = options.repoMigrations ?? 119
  for (let index = 0; index < migrationCount; index += 1) {
    mkdirSync(join(migrations, `2026${String(index).padStart(4, '0')}_m`), { recursive: true })
  }
  mkdirSync(join(repo, 'scripts/agent'), { recursive: true })
  writeFileSync(join(repo, 'scripts/agent/agent-pack.sh'), '#!/usr/bin/env bash\n', 'utf8')
  mkdirSync(join(repo, 'scripts/deploy'), { recursive: true })
  for (const name of [
    'common.sh',
    'remote-build.sh',
    'remote-switch.sh',
    'remote-migrate.sh',
    'remote-verify.sh',
    'remote-rollback.sh',
    'remote-nginx.sh',
  ]) {
    writeFileSync(join(repo, 'scripts/deploy', name), '#!/usr/bin/env bash\n', 'utf8')
  }
  const appDir = join(root, 'app')
  mkdirSync(appDir, { recursive: true })
  const releaseFile = join(appDir, 'RELEASE_VERSION')
  writeFileSync(releaseFile, `${options.prev ?? PREV}\n`, 'utf8')
  const staging = join(root, 'staging')
  mkdirSync(staging, { recursive: true })
  const workDir = join(root, 'work')
  mkdirSync(workDir, { recursive: true })
  const recordsDir = join(root, 'deploys')
  const stagingEnvPath = join(root, 'staging.env')
  const archivePath = join(root, 'release.tar.gz')
  const reuseDir = join(root, 'reuse')
  if (options.reuseStaging === true) {
    mkdirSync(reuseDir, { recursive: true })
    writeFileSync(join(reuseDir, 'RELEASE_VERSION'), `${HEAD}\n`, 'utf8')
    writeFileSync(join(reuseDir, 'package.json'), '{"name":"reuse"}\n', 'utf8')
  }
  const calls: CommandInput[] = []
  const phases: string[] = []

  const writeLive = (version: string): void => writeFileSync(releaseFile, `${version}\n`, 'utf8')

  const runner: CommandRunner = async (input) => {
    calls.push(input)
    const args = [...input.args]
    const joined = `${input.command} ${args.join(' ')}`

    if (joined.startsWith('git status --porcelain')) return ok(options.status ?? '')
    if (joined.startsWith('git rev-parse HEAD')) return ok(options.head ?? HEAD)
    if (joined.startsWith('git rev-parse origin/main')) return ok(REMOTE)
    if (joined.startsWith('git merge-base --is-ancestor')) {
      const target = args[2]
      if (target === (options.prev ?? PREV)) {
        return { code: options.ancestorCode ?? 0, stdout: '', stderr: '' }
      }
      return { code: options.ffCode ?? 0, stdout: '', stderr: '' }
    }
    if (input.command === 'sudo') {
      const sql = args[args.length - 1] ?? ''
      if (sql.includes('finished_at is not null')) return ok(`${options.applied ?? 119}\n`)
      return ok(`${options.failed ?? 0}\n`)
    }
    if (input.command === 'df') {
      const available = options.diskKb ?? 22 * 1024 * 1024
      return ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda3 40000000 16000000 ${available} 43% /\n`)
    }
    if (input.command === 'bash' && args[0] === '-lc') return ok('120\n')
    if (joined.startsWith('git fetch')) return { code: options.fetchCode ?? 0, stdout: '', stderr: '' }
    if (joined.startsWith('git push')) {
      return { code: options.pushCode ?? 0, stdout: options.pushOut ?? '', stderr: '' }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('agent-pack.sh')) {
      writeFileSync(archivePath, Buffer.alloc(1024 * 1024 + 16))
      return ok('PACK_OK release=x\n')
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-build.sh')) {
      writeFileSync(stagingEnvPath, `STAGING=${staging}\n`, 'utf8')
      return {
        code: options.buildCode ?? 0,
        stdout: options.buildOut ?? `BUILD_OK RELEASE=${HEAD} STAGING=${staging}\n`,
        stderr: '',
      }
    }
    if (input.command === 'npm' && args[0] === 'run') {
      return { code: options.testCode ?? 0, stdout: options.testOut ?? '# pass 275\n# fail 0\n', stderr: '' }
    }
    if (input.command === 'npx' && args[0] === 'vitest') {
      return { code: options.testCode ?? 0, stdout: `Test Files  86 passed\n${options.testOut ?? ''}`, stderr: '' }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-migrate.sh')) {
      return { code: options.migrateCode ?? 0, stdout: 'MIGRATE_OK applied=119\n', stderr: '' }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-switch.sh')) {
      const switchCode = options.switchCode ?? 0
      if (options.switchWritesRelease ?? (switchCode === 0)) {
        writeLive(options.liveAfterSwitch ?? HEAD)
      }
      return {
        code: switchCode,
        stdout:
          switchCode === 0
            ? `SWITCH_OK from=${PREV} to=${HEAD} backup=/opt/dilee/app.backup-test\n`
            : '',
        stderr: switchCode === 0 ? '' : 'health 探测失败',
      }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-verify.sh')) {
      return { code: options.verifyCode ?? 0, stdout: `release:            ${HEAD}\n`, stderr: '' }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-nginx.sh')) {
      return { code: options.edgeCode ?? 0, stdout: 'OK：边缘放行\n', stderr: '' }
    }
    if (input.command === 'bash' && (args[0] ?? '').endsWith('remote-rollback.sh')) {
      writeLive(options.prev ?? PREV)
      return { code: options.rollbackCode ?? 0, stdout: 'ROLLBACK_OK release=b\n', stderr: '' }
    }
    return ok('')
  }

  const config: DeployConfig = {
    repoPath: repo,
    rootDir: root,
    appDir,
    workDir,
    archivePath,
    recordsDir,
    stagingEnvPath,
    gitRemote: 'origin',
    gitBranch: 'main',
    keepBackups: 3,
    requirePush: options.requirePush ?? true,
    skipTests: options.skipTests ?? false,
    reuseStaging: options.reuseStaging === true ? reuseDir : null,
    minFreeGb: 1,
    timeouts: defaultDeployTimeouts(),
    now: () => new Date('2026-11-16T06:00:00.000Z'),
    log: () => {},
    runner,
  }

  return {
    root,
    config,
    calls,
    phases,
    releaseFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

async function run(harness: Harness): Promise<DeployResult> {
  return await runDeploy({
    config: harness.config,
    hooks: { onPhase: (phase) => harness.phases.push(phase) },
  })
}

function called(harness: Harness, needle: string): boolean {
  return harness.calls.some((call) => `${call.command} ${call.args.join(' ')}`.includes(needle))
}

test('成功路径：推送、构建、测试、迁移、切换、核验、边缘全过', async () => {
  const harness = setup()
  try {
    const result = await run(harness)
    assert.equal(result.ok, true, result.failure ?? '')
    assert.equal(result.pushed, true)
    assert.equal(result.rolledBack, false)
    assert.equal(result.release, HEAD)
    assert.equal(result.previousVersion, PREV)
    assert.equal(result.phase, 'done')
    assert.equal(result.backupDir, '/opt/dilee/app.backup-test')
    assert.ok(harness.phases.includes('build'))
    assert.ok(harness.phases.includes('test'))
    assert.ok(harness.phases.includes('switch'))
    assert.ok(harness.phases.includes('done'))
    assert.ok(called(harness, 'git push origin HEAD:refs/heads/main'))
    assert.ok(called(harness, 'vitest run'))
    assert.ok(called(harness, 'remote-nginx.sh'))
    assert.ok(existsSync(harness.config.recordsDir))
    assert.ok(readdirSync(harness.config.recordsDir).length >= 1)
    // git 只读探测必须带仓库 cwd：漏掉时 `merge-base ... HEAD` 会在进程 cwd 里跑，
    // 线上实测直接误判「基线落后于线上」。
    const mergeBaseCall = harness.calls.find((call) => call.command === 'git' && call.args[0] === 'merge-base')
    assert.equal(mergeBaseCall?.cwd, harness.config.repoPath)
    const remoteRevParse = harness.calls.find(
      (call) => call.command === 'git' && call.args[0] === 'rev-parse' && call.args[1] === 'origin/main',
    )
    assert.equal(remoteRevParse?.cwd, harness.config.repoPath)
  } finally {
    harness.cleanup()
  }
})

test('工作区脏：拒绝部署，不推送不构建', async () => {
  const harness = setup({ status: ' M apps/web/a.tsx\n' })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'preflight')
    assert.match(result.failure ?? '', /未提交改动/)
    assert.equal(called(harness, 'git push'), false)
    assert.equal(called(harness, 'remote-build.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('基线倒挂：线上版本不是 HEAD 祖先，拒绝部署', async () => {
  const harness = setup({ ancestorCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.match(result.failure ?? '', /基线落后于线上/)
    assert.equal(called(harness, 'git push'), false)
  } finally {
    harness.cleanup()
  }
})

test('有未应用迁移：按黑名单拒绝，不自动 migrate', async () => {
  const harness = setup({ repoMigrations: 121, applied: 119 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.match(result.failure ?? '', /2 个未应用迁移/)
    assert.match(result.failure ?? '', /不准动生产库/)
    assert.equal(called(harness, 'remote-migrate.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('失败迁移残留：拒绝部署', async () => {
  const harness = setup({ failed: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.match(result.failure ?? '', /失败迁移/)
  } finally {
    harness.cleanup()
  }
})

test('GitHub 远端有本地没有的提交：拒绝强推', async () => {
  const harness = setup({ ffCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'push')
    assert.match(result.failure ?? '', /拒绝强推/)
    assert.equal(called(harness, 'git push origin HEAD'), false)
    assert.equal(called(harness, 'remote-build.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('push 失败：中止，不构建不切换', async () => {
  const harness = setup({ pushCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'push')
    assert.match(result.failure ?? '', /git push 失败/)
    assert.equal(called(harness, 'remote-build.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('构建失败：不迁移不切换，线上版本不变', async () => {
  const harness = setup({ buildCode: 1, buildOut: 'npm ci 失败\n' })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'build')
    assert.equal(called(harness, 'remote-migrate.sh'), false)
    assert.equal(called(harness, 'remote-switch.sh'), false)
    assert.equal(readFileSync(harness.releaseFile, 'utf8').trim(), PREV)
  } finally {
    harness.cleanup()
  }
})

test('测试门禁失败：不切换', async () => {
  const harness = setup({ testCode: 1, testOut: '# fail 3\n' })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'test')
    assert.equal(called(harness, 'remote-switch.sh'), false)
    // 失败输出必须落盘：只回 8 行看不出哪条红了。
    assert.ok(existsSync(join(harness.config.workDir, 'test-gate.log')))
  } finally {
    harness.cleanup()
  }
})

test('skipTests 时不跑测试门禁', async () => {
  const harness = setup({ skipTests: true })
  try {
    const result = await run(harness)
    assert.equal(result.ok, true, result.failure ?? '')
    assert.equal(called(harness, 'vitest'), false)
    assert.equal(called(harness, 'run typecheck'), false)
  } finally {
    harness.cleanup()
  }
})

test('切换失败且未切换：不回滚（旧版本还在跑）', async () => {
  const harness = setup({ switchCode: 1, switchWritesRelease: false })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.phase, 'switch')
    assert.equal(result.rolledBack, false)
    assert.equal(called(harness, 'remote-rollback.sh'), false)
    assert.equal(readFileSync(harness.releaseFile, 'utf8').trim(), PREV)
  } finally {
    harness.cleanup()
  }
})

test('切换后失败：自动回滚，线上恢复旧版本', async () => {
  const harness = setup({ switchCode: 1, switchWritesRelease: true })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, true)
    assert.equal(result.phase, 'rolled-back')
    assert.ok(called(harness, 'remote-rollback.sh'))
    assert.equal(readFileSync(harness.releaseFile, 'utf8').trim(), PREV)
  } finally {
    harness.cleanup()
  }
})

test('核验失败：自动回滚', async () => {
  const harness = setup({ verifyCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, true)
    assert.equal(result.phase, 'rolled-back')
    assert.ok(called(harness, 'remote-rollback.sh'))
  } finally {
    harness.cleanup()
  }
})

test('回滚失败：如实报出，不假装成功', async () => {
  const harness = setup({ verifyCode: 1, rollbackCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, false)
    assert.match(result.failure ?? '', /回滚失败/)
  } finally {
    harness.cleanup()
  }
})

test('边缘探针失败：应用已上线，记警告不回滚', async () => {
  const harness = setup({ edgeCode: 1 })
  try {
    const result = await run(harness)
    assert.equal(result.ok, true, result.failure ?? '')
    assert.equal(result.rolledBack, false)
    assert.match(result.warning ?? '', /边缘探针/)
    assert.equal(called(harness, 'remote-rollback.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('requirePush=false：跳过推送但仍部署', async () => {
  const harness = setup({ requirePush: false })
  try {
    const result = await run(harness)
    assert.equal(result.ok, true, result.failure ?? '')
    assert.equal(result.pushed, false)
    assert.equal(called(harness, 'git push'), false)
    assert.ok(called(harness, 'remote-switch.sh'))
  } finally {
    harness.cleanup()
  }
})

test('reuseStaging：跳过打包与构建，只重跑门禁与切换', async () => {
  const harness = setup({ reuseStaging: true })
  try {
    const result = await run(harness)
    assert.equal(result.ok, true, result.failure ?? '')
    assert.equal(called(harness, 'agent-pack.sh'), false)
    assert.equal(called(harness, 'remote-build.sh'), false)
    assert.ok(called(harness, 'vitest run'))
    assert.ok(called(harness, 'remote-switch.sh'))
  } finally {
    harness.cleanup()
  }
})

test('reuseStaging 版本不符：拒绝复用', async () => {
  const harness = setup({ reuseStaging: true })
  try {
    writeFileSync(join(harness.config.reuseStaging ?? '', 'RELEASE_VERSION'), `${'f'.repeat(40)}\n`, 'utf8')
    const result = await run(harness)
    assert.equal(result.ok, false)
    assert.match(result.failure ?? '', /版本不符/)
    assert.equal(called(harness, 'remote-switch.sh'), false)
  } finally {
    harness.cleanup()
  }
})

test('辅助函数：迁移目录计数与短版本号', () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-deploy-util-'))
  try {
    const dir = join(root, 'migrations')
    mkdirSync(join(dir, 'a'), { recursive: true })
    mkdirSync(join(dir, 'b'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), 'x', 'utf8')
    assert.equal(countMigrationDirs(dir), 2)
    assert.equal(shortVersion(HEAD), 'aaaaaaaa')
    assert.equal(shortVersion(null), '(unknown)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
