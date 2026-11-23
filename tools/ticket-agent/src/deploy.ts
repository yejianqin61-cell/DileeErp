/**
 * 自主部署：把「推送 GitHub → 构建 → 测试 → 迁移检查 → 切换 → 核验 → 回滚」固化成一条腿。
 *
 * 为什么不重写部署流程：生产部署标准已经存在
 * （.agent/deployment/server-incremental-deployment-standard.md），
 * 并固化成 scripts/deploy/remote-*.sh。这里只做编排与判定，部署细节仍然只有一份实现。
 *
 * 为什么先推 GitHub 再部署：线上跑的代码必须能在 GitHub 找到对应提交；
 * 否则回滚、比对、追责都没有锚点。推送失败就中止，不继续花 20 分钟构建。
 *
 * 为什么有未应用迁移就停：用户 2026-11-13 定的唯一硬黑名单是「不准动生产库」。
 * 迁移是 DDL，必须人工执行；这里只核对迁移数，不自动跑。
 *
 * 为什么失败要自动回滚：用户 2026-11-13 拍板「全自动上线失败自动回滚」。
 * 备份只有一份，回滚也只有一次机会，所以回滚失败要大声报出来，不能假装成功。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { RUN_TAG_ENV, sweepRun } from './run-janitor.ts'

/** 服务器上构建/部署用的 PATH。刻意不含 /opt/node24：部署标准一直用系统 node（v22）。 */
export const DEFAULT_DEPLOY_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export type DeployPhase =
  | 'preflight'
  | 'push'
  | 'pack'
  | 'build'
  | 'test'
  | 'migrate'
  | 'switch'
  | 'verify'
  | 'edge'
  | 'done'
  | 'rollback'
  | 'rolled-back'
  | 'failed'

export interface CommandInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  /** 每收到一行 stdout 回调一次，用于把构建/测试进度透出去。 */
  readonly onLine?: (line: string) => void
  /**
   * 是否注入 DILEE_RUN_ID 清理标记。默认 true。
   *
   * 调 `pm2 start` 的命令必须传 false：PM2 启动的进程会继承这个标记，
   * 机器人下次启动清场时会把生产应用当成残留进程杀掉（2026-11-16 真实事故）。
   */
  readonly keepRunTag?: boolean
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type CommandRunner = (input: CommandInput) => Promise<CommandResult>

export interface DeployTimeouts {
  gitMs: number
  packMs: number
  buildMs: number
  testMs: number
  migrateMs: number
  switchMs: number
  verifyMs: number
  edgeMs: number
  rollbackMs: number
}

export interface DeployConfig {
  /** Agent 工作区（git 仓库）。 */
  repoPath: string
  /** /opt/dilee。 */
  rootDir: string
  /** /opt/dilee/app。 */
  appDir: string
  /** 临时工作目录，放部署脚本与日志。 */
  workDir: string
  /** 发布包路径。 */
  archivePath: string
  /** 部署审计记录目录。 */
  recordsDir: string
  /** remote-build 写出暂存目录的 env 文件，默认 /tmp/dilee-staging.env。测试可覆盖。 */
  stagingEnvPath?: string
  /**
   * 复用已构建好的候选目录（只重跑测试门禁/切换）。默认 null。
   * 用途：测试门禁因环境问题失败、修完后不想再花十几分钟重建。
   * 会校验目录里的 RELEASE_VERSION 与 HEAD 一致，不一致直接拒绝。
   */
  reuseStaging?: string | null
  gitRemote: string
  gitBranch: string
  keepBackups: number
  requirePush: boolean
  skipTests: boolean
  minFreeGb: number
  /**
   * 部署必须是「站在主干上」的。为空表示不校验（测试与本地用）。
   *
   * 2026-11-23 加了工单分支：正常流程是「run 成功 → 合入主干 → 再部署」。
   * 若此时 HEAD 还停在 `ticket/T-00XX` 上，说明该单没收尾成功，
   * 部署上去的就是半成品 —— 宁可拒绝。
   */
  mainBranch?: string
  timeouts: DeployTimeouts
  /** 子进程 PATH 覆盖，测试用。 */
  path?: string
  /** 注入用：替换真实命令执行。 */
  runner?: CommandRunner
  now?: () => Date
  log?: (line: string) => void
}

export interface DeployResult {
  ok: boolean
  /** 是否推送到了 GitHub（或本来就没有可推的提交）。 */
  pushed: boolean
  /** 是否执行过自动回滚。 */
  rolledBack: boolean
  release: string
  previousVersion: string
  backupDir: string | null
  phase: DeployPhase
  failure: string | null
  /** 非致命问题（例如边缘探针失败：应用已上线，但上传体积核验没过）。 */
  warning: string | null
  startedAt: string
  finishedAt: string
  durationMs: number
}

export interface DeployHooks {
  onPhase?: (phase: DeployPhase, message: string) => void
  /** 构建/测试输出行。已经由部署脚本写日志文件，这里只适合做少量透传。 */
  onLine?: (phase: DeployPhase, line: string) => void
}

export interface DeployInput {
  config: DeployConfig
  hooks?: DeployHooks
}

/** 部署失败。phase 是失败发生的阶段，用于决定是否回滚。 */
export class DeployFailure extends Error {
  readonly phase: DeployPhase

  constructor(phase: DeployPhase, message: string) {
    super(message)
    this.name = 'DeployFailure'
    this.phase = phase
  }
}

/** 默认超时。构建实测约 10–11 分钟，测试门禁约 8–12 分钟，留足余量。 */
export function defaultDeployTimeouts(): DeployTimeouts {
  return {
    gitMs: 2 * 60 * 1000,
    packMs: 3 * 60 * 1000,
    buildMs: 40 * 60 * 1000,
    testMs: 30 * 60 * 1000,
    migrateMs: 5 * 60 * 1000,
    switchMs: 10 * 60 * 1000,
    verifyMs: 3 * 60 * 1000,
    edgeMs: 6 * 60 * 1000,
    rollbackMs: 6 * 60 * 1000,
  }
}

/**
 * 真实命令执行器。
 *
 * 超时后先杀进程组，再按 DILEE_RUN_ID 标记扫 /proc 清理孙进程 ——
 * 与 harness-runner 同一个教训：npm/next 会 setsid，`kill(-pid)` 够不着。
 */
export function createCommandRunner(options: { tag?: string; baseEnv?: NodeJS.ProcessEnv } = {}): CommandRunner {
  return (input) => {
    const tag = options.tag ?? `deploy-${randomUUID()}`
    const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000
    return new Promise<CommandResult>((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let buffer = ''
      let timedOut = false

      const finish = (code: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      }

      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...options.baseEnv,
          PATH: DEFAULT_DEPLOY_PATH,
          // 调 pm2 start 的命令不能带标记：否则 PM2 托管的 api/web 会继承它，
          // 机器人下次启动清场时把它们当残留杀掉（2026-11-16 真实事故）。
          ...(input.keepRunTag === false ? {} : { [RUN_TAG_ENV]: tag }),
          ...input.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            // 已经退出
          }
        }
        // keepRunTag=false 的命令没有标记，扫不到东西；跳过即可。
        if (input.keepRunTag === false) return
        try {
          sweepRun(tag)
        } catch {
          // 清理失败由下次启动清场兜住
        }
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        // 只留最后 64KB：测试输出可能几千行，保留全量没有意义。
        stdout = (stdout + chunk).slice(-64 * 1024)
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          try {
            input.onLine?.(line)
          } catch {
            // 回调失败不影响命令
          }
          newline = buffer.indexOf('\n')
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-32 * 1024)
      })

      child.on('error', (error) => {
        stderr = `${stderr}\n${error.message}`.trim()
        finish(-1)
      })

      child.on('close', (code) => {
        if (timedOut) {
          stderr = `${stderr}\n[deploy] 命令超过 ${methodLabel(timeoutMs)}未结束，已杀进程组`.trim()
          finish(124)
          return
        }
        finish(code ?? -1)
      })
    })
  }
}

function methodLabel(ms: number): string {
  const minutes = Math.round(ms / 60000)
  return `${minutes} 分钟`
}

function readTrim(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text.length === 0 ? null : text
  } catch {
    return null
  }
}

export function shortVersion(version: string | null): string {
  return version === null || version.length === 0 ? '(unknown)' : version.slice(0, 8)
}

/** 数仓库里的迁移目录。升级/回退判断都靠它。 */
export function countMigrationDirs(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
}

function tail(result: CommandResult, lines = 8): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  if (text.length === 0) return `退出码 ${result.code}`
  return text.split('\n').slice(-lines).join(' | ')
}

interface DeployState {
  phase: DeployPhase
  release: string
  previousVersion: string
  backupDir: string | null
  pushed: boolean
  rolledBack: boolean
  switched: boolean
  warning: string | null
}

/**
 * 跑一次完整部署。
 *
 * 返回值而不是抛异常：调用方（Coordinator）无论如何都要把结果写回工单与飞书，
 * 用返回值能让「失败也要有结果」变成类型层面的事实。
 */
export async function runDeploy(input: DeployInput): Promise<DeployResult> {
  const config = input.config
  const hooks = input.hooks ?? {}
  const runner = config.runner ?? createCommandRunner()
  const now = config.now ?? (() => new Date())
  const log = config.log ?? ((line) => console.log(line))
  const path = config.path ?? DEFAULT_DEPLOY_PATH
  const startedAt = now()
  const state: DeployState = {
    phase: 'preflight',
    release: '',
    previousVersion: '',
    backupDir: null,
    pushed: false,
    rolledBack: false,
    switched: false,
    warning: null,
  }

  const elapsed = (): number => now().getTime() - startedAt.getTime()

  const emit = (phase: DeployPhase, message: string): void => {
    state.phase = phase
    log(`[deploy] ${phase} +${Math.round(elapsed() / 1000)}s ${message}`)
    try {
      hooks.onPhase?.(phase, message)
    } catch {
      // 上报失败不影响部署
    }
  }

  /** 执行命令，失败即抛 DeployFailure。 */
  const must = async (
    phase: DeployPhase,
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs: number; onLine?: (line: string) => void } = {
      timeoutMs: 60_000,
    },
  ): Promise<CommandResult> => {
    const result = await runner({
      command,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { PATH: path, DILEE_ROOT: config.rootDir, ...(options.env ?? {}) },
      timeoutMs: options.timeoutMs,
      ...(options.onLine === undefined ? {} : { onLine: options.onLine }),
    })
    if (result.code !== 0) {
      throw new DeployFailure(phase, `${command} ${args.join(' ')} 失败（退出码 ${result.code}）：${tail(result)}`)
    }
    return result
  }

  /** 只读命令，失败返回 null 而不是抛错（例如迁移状态读不到时给更准的错误）。 */
  const probe = async (
    command: string,
    args: readonly string[],
    timeoutMs = 60_000,
    cwd?: string,
  ): Promise<CommandResult> => {
    return await runner({
      command,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      env: { PATH: path, DILEE_ROOT: config.rootDir },
      timeoutMs,
    })
  }

  const readPgCount = async (sql: string): Promise<number | null> => {
    const result = await probe(
      'sudo',
      ['-n', 'docker', 'exec', 'app-postgres-1', 'psql', '-U', 'dilee', '-d', 'dilee_erp', '-tAc', sql],
      60_000,
    )
    if (result.code !== 0) return null
    const value = Number(result.stdout.trim())
    return Number.isFinite(value) ? value : null
  }

  const readDiskFreeKb = async (): Promise<number | null> => {
    const result = await probe('df', ['-Pk', '/'], 30_000)
    if (result.code !== 0) return null
    const line = result.stdout.trim().split('\n').at(-1) ?? ''
    const available = Number(line.split(/\s+/)[3])
    return Number.isFinite(available) ? available : null
  }

  const readErrlogLines = async (): Promise<number> => {
    const result = await probe('bash', ['-lc', 'wc -l < /home/ubuntu/.pm2/logs/dilee-api-error.log'], 30_000)
    const value = Number(result.stdout.trim())
    return Number.isFinite(value) ? value : 0
  }

  const stagingDir = (): string | null => {
    const envPath = config.stagingEnvPath ?? '/tmp/dilee-staging.env'
    const content = readTrim(envPath)
    if (content === null) return null
    const match = /^STAGING=(.+)$/m.exec(content)
    return match === null ? null : match[1].trim()
  }

  const liveVersion = (): string | null => readTrim(join(config.appDir, 'RELEASE_VERSION'))

  const writeRecord = (result: DeployResult): void => {
    try {
      mkdirSync(config.recordsDir, { recursive: true })
      const name = `deploy-${result.startedAt.replace(/[:.]/g, '-')}.json`
      writeFileSync(join(config.recordsDir, name), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`[deploy] 写审计记录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const rollback = async (reason: string): Promise<boolean> => {
    emit('rollback', `自动回滚（原因：${reason}）`)
    const result = await runner({
      command: 'bash',
      args: [join(config.workDir, 'remote-rollback.sh')],
      env: { PATH: path, DILEE_ROOT: config.rootDir },
      timeoutMs: config.timeouts.rollbackMs,
    })
    const ok = result.code === 0 && result.stdout.includes('ROLLBACK_OK')
    if (ok) {
      state.rolledBack = true
      emit('rolled-back', `已回滚到 ${shortVersion(liveVersion())}`)
    } else {
      log(`[deploy] 回滚失败：${tail(result)}`)
    }
    return ok
  }

  const finishFailure = async (error: unknown): Promise<DeployResult> => {
    const message = error instanceof Error ? error.message : String(error)
    const failedPhase = state.phase
    let rollbackNote = ''
    if (state.switched && !state.rolledBack) {
      const ok = await rollback(message)
      rollbackNote = ok
        ? '（已自动回滚）'
        : '（自动回滚失败！需要人工按标准 §回滚 处理）'
    }
    const finishedAt = now()
    const result: DeployResult = {
      ok: false,
      pushed: state.pushed,
      rolledBack: state.rolledBack,
      release: state.release,
      previousVersion: state.previousVersion,
      backupDir: state.backupDir,
      phase: state.rolledBack ? 'rolled-back' : failedPhase,
      failure: `${message}${rollbackNote}`,
      warning: state.warning,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
    log(`[deploy] 失败：${result.failure}`)
    try {
      hooks.onPhase?.(result.phase, result.failure ?? '部署失败')
    } catch {
      // ignore
    }
    writeRecord(result)
    return result
  }

  try {
    // ───────────────────────── 1. 预检 ─────────────────────────
    emit('preflight', '预检：工作区、基线、迁移、磁盘')
    const status = await must('preflight', 'git', ['status', '--porcelain'], {
      cwd: config.repoPath,
      timeoutMs: config.timeouts.gitMs,
    })
    if (status.stdout.trim().length > 0) {
      throw new DeployFailure(
        'preflight',
        `工作区有未提交改动，拒绝部署：${status.stdout.trim().split('\n').slice(0, 5).join(' / ')}`,
      )
    }

    // 必须站在主干上：停在工单分支等于该单没收尾成功，部署上去就是半成品。
    if (config.mainBranch !== undefined) {
      const branch = await probe('git', ['rev-parse', '--abbrev-ref', 'HEAD'], config.timeouts.gitMs, config.repoPath)
      const current = branch.stdout.trim()
      if (branch.code === 0 && current.length > 0 && current !== config.mainBranch) {
        throw new DeployFailure(
          'preflight',
          `当前在分支 ${current} 上，不是主干 ${config.mainBranch}。工单分支未合入，拒绝部署半成品。`,
        )
      }
    }

    state.release = (
      await must('preflight', 'git', ['rev-parse', 'HEAD'], { cwd: config.repoPath, timeoutMs: config.timeouts.gitMs })
    ).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(state.release)) {
      throw new DeployFailure('preflight', `读不到有效 HEAD：${state.release}`)
    }

    const live = liveVersion()
    if (live === null) throw new DeployFailure('preflight', `读不到线上版本：${config.appDir}/RELEASE_VERSION`)
    state.previousVersion = live

    if (live !== state.release) {
      const ancestor = await probe(
        'git',
        ['merge-base', '--is-ancestor', live, 'HEAD'],
        config.timeouts.gitMs,
        config.repoPath,
      )
      if (ancestor.code !== 0) {
        throw new DeployFailure(
          'preflight',
          `线上版本 ${shortVersion(live)} 不是当前 HEAD 的祖先（工作区基线落后于线上）。先把工作区同步到线上版本，再部署。`,
        )
      }
    }

    const repoMigrations = countMigrationDirs(join(config.repoPath, 'apps/api/prisma/migrations'))
    const appliedMigrations = await readPgCount(
      'select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null',
    )
    if (appliedMigrations === null) {
      throw new DeployFailure('preflight', '读不到生产库迁移状态（docker/psql 不可用），拒绝部署')
    }
    const failedMigrations = await readPgCount(
      'select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null',
    )
    if (failedMigrations === null) {
      throw new DeployFailure('preflight', '读不到生产库失败迁移数，拒绝部署')
    }
    if (failedMigrations > 0) {
      throw new DeployFailure(
        'preflight',
        `生产库存在 ${failedMigrations} 条失败迁移（finished_at IS NULL），需先人工 migrate resolve；按黑名单不自动处理`,
      )
    }
    if (repoMigrations > appliedMigrations) {
      throw new DeployFailure(
        'preflight',
        `仓库有 ${repoMigrations} 个迁移、生产库已应用 ${appliedMigrations} 个：有 ${repoMigrations - appliedMigrations} 个未应用迁移。` +
          '按「不准动生产库」黑名单，不自动执行迁移，请人工处理后再部署。',
      )
    }

    const freeKb = await readDiskFreeKb()
    if (freeKb === null) throw new DeployFailure('preflight', '读不到磁盘可用空间')
    if (freeKb < config.minFreeGb * 1024 * 1024) {
      throw new DeployFailure('preflight', `磁盘可用 ${Math.round(freeKb / 1024)} MB < ${config.minFreeGb} GB，拒绝部署`)
    }

    const packScript = join(config.repoPath, 'scripts/agent/agent-pack.sh')
    if (!existsSync(packScript)) throw new DeployFailure('preflight', `缺少打包脚本：${packScript}`)
    const deployScripts = join(config.repoPath, 'scripts/deploy')
    if (!existsSync(deployScripts)) throw new DeployFailure('preflight', `缺少部署脚本目录：${deployScripts}`)

    log(
      `[deploy] release=${shortVersion(state.release)} previous=${shortVersion(live)} ` +
        `migrations=${repoMigrations}/${appliedMigrations} free=${Math.round(freeKb / 1024)}MB`,
    )

    // ───────────────────────── 2. 推送 GitHub ─────────────────────────
    if (config.requirePush) {
      emit('push', '推送 GitHub')
      const fetch = await runner({
        command: 'git',
        args: ['fetch', config.gitRemote, config.gitBranch],
        cwd: config.repoPath,
        env: { PATH: path },
        timeoutMs: config.timeouts.gitMs,
      })
      if (fetch.code !== 0) {
        throw new DeployFailure('push', `git fetch ${config.gitRemote} 失败（检查网络/远端地址）：${tail(fetch)}`)
      }
      const remoteRef = `${config.gitRemote}/${config.gitBranch}`
      const remoteHeadResult = await probe('git', ['rev-parse', remoteRef], config.timeouts.gitMs, config.repoPath)
      if (remoteHeadResult.code !== 0) {
        throw new DeployFailure('push', `读不到远端分支 ${remoteRef}`)
      }
      const remoteHead = remoteHeadResult.stdout.trim()
      const isAncestor = async (sha: string): Promise<boolean> => {
        const result = await probe(
          'git',
          ['merge-base', '--is-ancestor', sha, 'HEAD'],
          config.timeouts.gitMs,
          config.repoPath,
        )
        return result.code === 0
      }
      if (remoteHead.length > 0 && !(await isAncestor(remoteHead))) {
        // 远端有本地没有的提交（典型：文档提交从别的机器直接推了 main），
        // 本地 HEAD 推到 main 不是快进。
        //
        // 旧行为是直接拒绝并回一句「先同步仓库再部署」——人到场当然会 `git pull`，
        // 但机器人没有这个动作，只能卡死等人（2026-11-17 真实卡住一次）。
        // 现在自己同步：本地只落后就快进；本地有提交就 rebase 到远端之上（失败可原子回退）。
        const behindOnly = await probe(
          'git',
          ['merge-base', '--is-ancestor', 'HEAD', remoteHead],
          config.timeouts.gitMs,
          config.repoPath,
        )
        const syncArgs = behindOnly.code === 0 ? ['merge', '--ff-only', remoteRef] : ['rebase', remoteRef]
        emit('push', '推送 GitHub（先同步远端）')
        log(
          `[deploy] 远端 ${remoteRef}=${shortVersion(remoteHead)} 不在 HEAD 历史里，` +
            `执行 git ${syncArgs.join(' ')}`,
        )
        const sync = await runner({
          command: 'git',
          args: syncArgs,
          cwd: config.repoPath,
          env: { PATH: path },
          timeoutMs: config.timeouts.gitMs,
        })
        if (sync.code !== 0) {
          if (syncArgs[0] === 'rebase') {
            const abort = await runner({
              command: 'git',
              args: ['rebase', '--abort'],
              cwd: config.repoPath,
              env: { PATH: path },
              timeoutMs: config.timeouts.gitMs,
            })
            log(`[deploy] 同步失败，已回退 rebase（exit ${abort.code}）`)
          }
          throw new DeployFailure(
            'push',
            `同步 ${remoteRef} 失败（本地提交与远端 ${config.gitBranch} 冲突，需人工解决后再部署）：${tail(sync)}`,
          )
        }
        const headAfterSync = await probe('git', ['rev-parse', 'HEAD'], config.timeouts.gitMs, config.repoPath)
        const syncedRelease = headAfterSync.stdout.trim()
        if (/^[0-9a-f]{40}$/.test(syncedRelease)) {
          log(`[deploy] 仓库已同步，release ${shortVersion(state.release)} -> ${shortVersion(syncedRelease)}`)
          state.release = syncedRelease
        }
        if (!(await isAncestor(remoteHead))) {
          throw new DeployFailure(
            'push',
            `同步后远端 ${config.gitBranch} 仍不是 HEAD 的祖先（远端 ${shortVersion(remoteHead)}），拒绝强推。`,
          )
        }
      }
      const push = await runner({
        command: 'git',
        args: ['push', config.gitRemote, `HEAD:refs/heads/${config.gitBranch}`],
        cwd: config.repoPath,
        env: { PATH: path },
        timeoutMs: config.timeouts.gitMs,
      })
      if (push.code !== 0) {
        throw new DeployFailure(
          'push',
          `git push 失败（服务器 GitHub 凭据未配置或没有写权限？）：${tail(push)}`,
        )
      }
      state.pushed = true
      log(`[deploy] pushed ${shortVersion(state.release)} -> ${config.gitRemote}/${config.gitBranch}`)
    } else {
      log('[deploy] requirePush=false，跳过 GitHub 推送')
    }

    // ───────────────────────── 3. 打包 ─────────────────────────
    emit('pack', '准备部署工作目录')
    rmSync(config.workDir, { recursive: true, force: true })
    mkdirSync(config.workDir, { recursive: true })
    for (const name of readdirSync(deployScripts)) {
      // `.conf` 也要带走：边缘探针在**切换之后**跑，那时 staging 目录已经被提升成 app，
      // 原路径不存在；固定用 workDir 里的副本，别依赖 staging 还在原地。
      if (name.endsWith('.sh') || name.endsWith('.conf')) {
        cpSync(join(deployScripts, name), join(config.workDir, name))
      }
    }

    let staging: string
    if (config.reuseStaging !== undefined && config.reuseStaging !== null && config.reuseStaging.length > 0) {
      // 复用已构建好的候选目录：只重跑门禁，不再花十几分钟重建。
      emit('build', `复用候选目录（跳过打包与构建）：${config.reuseStaging}`)
      const versionInStaging = readTrim(join(config.reuseStaging, 'RELEASE_VERSION'))
      if (versionInStaging !== state.release) {
        throw new DeployFailure(
          'build',
          `复用目录版本不符：${config.reuseStaging} 是 ${shortVersion(versionInStaging)}，HEAD 是 ${shortVersion(state.release)}`,
        )
      }
      if (!existsSync(join(config.reuseStaging, 'package.json'))) {
        throw new DeployFailure('build', `复用目录缺少 package.json：${config.reuseStaging}`)
      }
      staging = config.reuseStaging
    } else {
      const pack = await must(
        'pack',
        'bash',
        [packScript, config.repoPath, 'HEAD', config.archivePath],
        { timeoutMs: config.timeouts.packMs },
      )
      if (!pack.stdout.includes('PACK_OK')) {
        throw new DeployFailure('pack', '打包未输出 PACK_OK')
      }
      let archiveSize = 0
      try {
        archiveSize = statSync(config.archivePath).size
      } catch {
        archiveSize = 0
      }
      if (archiveSize < 1024 * 1024) {
        throw new DeployFailure('pack', `发布包异常小（${archiveSize} 字节）`)
      }
      log(`[deploy] archive=${Math.round(archiveSize / 1024 / 1024)}MB`)

      // ───────────────────────── 4. 构建 ─────────────────────────
      emit('build', '服务器构建（npm ci + prisma generate + api/web build）')
      const build = await must('build', 'bash', [join(config.workDir, 'remote-build.sh')], {
        cwd: config.workDir,
        env: { ARCHIVE: config.archivePath },
        timeoutMs: config.timeouts.buildMs,
        onLine: (line) => hooks.onLine?.('build', line),
      })
      if (!build.stdout.includes('BUILD_OK')) {
        throw new DeployFailure('build', '构建完成但未输出 BUILD_OK')
      }
      const built = stagingDir()
      if (built === null) throw new DeployFailure('build', '构建完成但读不到暂存目录（/tmp/dilee-staging.env）')
      staging = built
    }
    log(`[deploy] staging=${staging}`)

    // ───────────────────────── 5. 测试门禁 ─────────────────────────
    if (!config.skipTests) {
      emit('test', '测试门禁（typecheck + 部署守卫 + API 单测 + Web 单测）')
      const gateLog: string[] = []
      const runGateStep = async (
        label: string,
        command: string,
        args: readonly string[],
        cwd: string,
      ): Promise<void> => {
        const result = await runner({
          command,
          args,
          cwd,
          env: {
            // 2 核机器，别让 tsc/vitest 按默认堆把内存打满（实测踩过 OOM）。
            PATH: path,
            NODE_OPTIONS: '--max-old-space-size=1536',
          },
          timeoutMs: config.timeouts.testMs,
          onLine: (line) => hooks.onLine?.('test', line),
        })
        gateLog.push(`===== ${label} (exit ${result.code}) =====\n${result.stdout}\n${result.stderr}`)
        if (result.code !== 0) {
          // 测试输出可能几千行，失败时必须落盘：只回 8 行根本看不出哪条红了。
          const logPath = join(config.workDir, 'test-gate.log')
          try {
            writeFileSync(logPath, gateLog.join('\n\n'), 'utf8')
          } catch {
            // 落盘失败不改变失败结论
          }
          throw new DeployFailure(
            'test',
            `测试门禁失败：${label}（退出码 ${result.code}）：${tail(result, 20)}\n完整日志：${logPath}`,
          )
        }
      }
      await runGateStep('typecheck', 'npm', ['run', 'typecheck'], staging)
      await runGateStep('部署脚本守卫', 'npm', ['run', 'test:deploy'], staging)
      await runGateStep('API 单测', 'npm', ['run', 'test:unit:api'], staging)
      await runGateStep('Web lib 单测', 'npm', ['run', 'test:lib', '--workspace=@dilee/web'], staging)
      // 2 核机器上 vitest 默认 4 worker 会把 CPU 打满，实测出现一片
      // "Test timed out in 10000ms" 的假红；限到 2 worker、放宽单测超时，
      // 并对 load 敏感的用例重试一次（--retry=1）：确定性失败仍会红。
      await runGateStep(
        'Web 组件测试（maxWorkers=2，60s 超时，失败重试 1 次）',
        'npx',
        ['vitest', 'run', '--maxWorkers=2', '--testTimeout=60000', '--retry=1'],
        join(staging, 'apps/web'),
      )
      log('[deploy] tests passed: typecheck / 部署守卫 / API / Web lib / Web 组件')
    } else {
      log('[deploy] skipTests=true，跳过测试门禁')
    }

    // ───────────────────────── 6. 迁移检查 ─────────────────────────
    emit('migrate', '迁移检查（只核对，不新增迁移）')
    const migrate = await must('migrate', 'bash', [join(config.workDir, 'remote-migrate.sh')], {
      env: { EXPECTED_MIGRATIONS: String(appliedMigrations) },
      timeoutMs: config.timeouts.migrateMs,
    })
    if (!migrate.stdout.includes('MIGRATE_OK')) {
      throw new DeployFailure('migrate', '迁移脚本未输出 MIGRATE_OK')
    }

    // ───────────────────────── 7. 切换 ─────────────────────────
    emit('switch', '切换目录并重启 PM2')
    const errlogBaseline = await readErrlogLines()
    const switchResult = await runner({
      command: 'bash',
      args: [join(config.workDir, 'remote-switch.sh')],
      env: {
        PATH: path,
        DILEE_ROOT: config.rootDir,
        KEEP_BACKUPS: String(config.keepBackups),
        ERRLOG_BASELINE: String(errlogBaseline),
      },
      timeoutMs: config.timeouts.switchMs,
      // 这个脚本会 `pm2 start`：绝不能带 DILEE_RUN_ID，否则生产应用会继承标记，
      // 机器人下次重启的清场逻辑会把它们 SIGKILL（2026-11-16 真实事故）。
      keepRunTag: false,
      onLine: (line) => hooks.onLine?.('switch', line),
    })
    // 目录被提升后，app/RELEASE_VERSION 就是新版本 —— 这是「是否已切换」的唯一可信判据。
    state.switched = liveVersion() === state.release
    const backupMatch = /backup=(\S+)/.exec(`${switchResult.stdout}\n${switchResult.stderr}`)
    state.backupDir = backupMatch === null ? null : backupMatch[1]
    if (switchResult.code !== 0 || !switchResult.stdout.includes('SWITCH_OK')) {
      throw new DeployFailure('switch', `切换失败：${tail(switchResult)}`)
    }
    emit('switch', `已切换 ${shortVersion(state.previousVersion)} → ${shortVersion(state.release)}`)

    // ───────────────────────── 8. 核验 ─────────────────────────
    emit('verify', '部署后核验（版本/健康/页面）')
    const verify = await must('verify', 'bash', [join(config.workDir, 'remote-verify.sh')], {
      env: { EXPECTED_MIGRATIONS: String(appliedMigrations) },
      timeoutMs: config.timeouts.verifyMs,
      onLine: (line) => hooks.onLine?.('verify', line),
    })
    const liveAfter = liveVersion()
    if (liveAfter !== state.release) {
      throw new DeployFailure('verify', `线上版本 ${shortVersion(liveAfter)} 与发布版本 ${shortVersion(state.release)} 不一致`)
    }
    if (!verify.stdout.includes(`release:            ${state.release}`) && !verify.stdout.includes(state.release)) {
      log('[deploy] 核验输出里没看到版本号，跳过文本比对（已用 RELEASE_VERSION 确认）')
    }

    // ───────────────────────── 9. 边缘探针（非致命） ─────────────────────────
    emit('edge', '边缘上传体积探针')
    const edge = await runner({
      command: 'bash',
      args: [join(config.workDir, 'remote-nginx.sh')],
      env: {
        PATH: path,
        DILEE_ROOT: config.rootDir,
        // 用 workDir 里的配置副本：切换后 staging 已改名为 app，原路径不再存在。
        CONF_SRC: join(config.workDir, 'nginx-dilee.conf'),
      },
      timeoutMs: config.timeouts.edgeMs,
      onLine: (line) => hooks.onLine?.('edge', line),
    })
    if (edge.code !== 0) {
      // 应用已经在跑新版本；回滚修不了 nginx。如实记警告，不假装成功也回滚。
      state.warning = `边缘探针未通过（应用已上线，上传体积核验需人工确认）：${tail(edge, 3)}`
      log(`[deploy] warning: ${state.warning}`)
    }

    emit('done', `已上线 ${shortVersion(state.release)}（上一版 ${shortVersion(state.previousVersion)}）`)
    const finishedAt = now()
    const result: DeployResult = {
      ok: true,
      pushed: state.pushed,
      rolledBack: false,
      release: state.release,
      previousVersion: state.previousVersion,
      backupDir: state.backupDir,
      phase: 'done',
      failure: null,
      warning: state.warning,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
    writeRecord(result)
    return result
  } catch (error) {
    return await finishFailure(error)
  }
}

/** 从环境变量构造配置的便捷函数。 */
export function deployConfigFromEnv(input: {
  env: NodeJS.ProcessEnv
  repoPath: string
  rootDir?: string
  now?: () => Date
  log?: (line: string) => void
  runner?: CommandRunner
}): DeployConfig {
  const env = input.env
  const rootDir = input.rootDir ?? '/opt/dilee'
  const number = (raw: string | undefined, fallback: number): number => {
    const value = Number(raw)
    return raw === undefined || raw.trim() === '' || !Number.isFinite(value) ? fallback : value
  }
  const flag = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw === undefined || raw.trim() === '') return fallback
    return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase())
  }
  return {
    repoPath: input.repoPath,
    rootDir,
    appDir: `${rootDir}/app`,
    workDir: env.DEPLOY_WORK_DIR?.trim() || '/tmp/dilee-deploy',
    archivePath: env.DEPLOY_ARCHIVE?.trim() || '/tmp/dilee-agent-release.tar.gz',
    recordsDir: env.DEPLOY_RECORDS_DIR?.trim() || `${rootDir}/deploys`,
    stagingEnvPath: env.DEPLOY_STAGING_ENV?.trim() || '/tmp/dilee-staging.env',
    reuseStaging: env.DEPLOY_REUSE_STAGING?.trim() || null,
    gitRemote: env.DEPLOY_GIT_REMOTE?.trim() || 'origin',
    gitBranch: env.DEPLOY_GIT_BRANCH?.trim() || 'main',
    keepBackups: Math.max(0, Math.round(number(env.DEPLOY_KEEP_BACKUPS, 3))),
    requirePush: flag(env.DEPLOY_REQUIRE_PUSH, true),
    skipTests: flag(env.DEPLOY_SKIP_TESTS, false),
    mainBranch: env.WORKSPACE_MAIN_BRANCH?.trim() || undefined,
    minFreeGb: Math.max(1, number(env.DEPLOY_MIN_FREE_GB, 5)),
    timeouts: defaultDeployTimeouts(),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  }
}
