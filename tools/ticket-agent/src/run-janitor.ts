/**
 * 孤儿进程清理。
 *
 * 为什么需要它（2026-11-14 实测）：
 * harness run 超时后，`process.kill(-pid)` 只杀掉了 dsh 主进程，
 * 它派生的 `npm run typecheck` / `tsc --noEmit` 活了下来，继续吃 CPU 与内存 36 分钟，
 * 把下一次 run 也拖到超时。
 *
 * 为什么进程组不够：DSH 的 bash 工具执行命令时会创建新的会话/进程组，
 * 于是子孙进程脱离了 dsh 的进程组，`kill(-pid)` 够不着它们。
 *
 * 所以改用**环境变量标记**：spawn 时给子进程注入 `DILEE_RUN_ID=<唯一值>`，
 * 该变量会被所有子孙继承（环境是 fork 时复制的）。
 * 超时时扫描 /proc/<pid>/environ，凡含这个标记的进程一律杀掉。
 * 这条路不依赖进程组、不依赖父子关系，能覆盖被 setsid 过的孙进程。
 *
 * 边界：只能杀同一用户的进程（/proc/<pid>/environ 仅对本用户可读）。
 * 跨用户残留要由 root 处理，这里明确不尝试。
 */

import { readdirSync, readFileSync } from 'node:fs'

/** 标记变量名。改这里要同步 harness-runner 的 spawn 环境。 */
export const RUN_TAG_ENV = 'DILEE_RUN_ID'

/**
 * PM2 托管进程的环境标记。
 *
 * 2026-11-16 线上事故：部署脚本的 `pm2 start` 从命令行继承了 `DILEE_RUN_ID`，
 * 于是两个生产应用（dilee-api / dilee-web）也带上了这个标记；
 * 机器人一重启，清场逻辑把它们当成「残留 run 进程」SIGKILL 掉了。
 * 所以清场必须**永远跳过 PM2 托管的进程**：它们的生命周期归 PM2，不归我们。
 */
const PM2_MARKERS = ['pm_id=', 'PM2_HOME=']

function isPm2Managed(vars: readonly string[]): boolean {
  return vars.some((item) => PM2_MARKERS.some((marker) => item.startsWith(marker)))
}

export interface ProcEntry {
  readonly pid: number
  /** /proc/<pid>/environ 的原始内容（NUL 分隔）。 */
  readonly environ: string
}

/** 从 /proc 读当前所有进程的环境块。读不到的（权限/已退出）跳过。 */
export function readProcTable(procRoot = '/proc'): ProcEntry[] {
  const entries: ProcEntry[] = []
  let names: string[]
  try {
    names = readdirSync(procRoot)
  } catch {
    return entries
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const environ = readFileSync(`${procRoot}/${name}/environ`, 'utf8')
      entries.push({ pid: Number(name), environ })
    } catch {
      // 进程已退出或无权读取，跳过
    }
  }
  return entries
}

/**
 * 在进程表里找出「带指定标记」的进程。
 *
 * 纯函数，便于用假进程表测试，不依赖真实 /proc。
 * 排除 `excludePid`（通常是当前进程自己）。
 */
export function findTagged(entries: readonly ProcEntry[], runId: string, excludePid?: number): number[] {
  const needle = `${RUN_TAG_ENV}=${runId}`
  const hits: number[] = []
  for (const entry of entries) {
    if (excludePid !== undefined && entry.pid === excludePid) continue
    // environ 是 NUL 分隔的 KEY=VALUE 列表，精确匹配一项
    const vars = entry.environ.split('\0')
    if (isPm2Managed(vars)) continue
    if (vars.includes(needle)) hits.push(entry.pid)
  }
  return hits
}

export interface SweepResult {
  readonly killed: readonly number[]
  readonly failed: readonly number[]
}

/**
 * 找出带任意 DILEE_RUN_ID 标记的进程（不限具体值）。
 *
 * 用途：进程启动时清场。刚启动时不可能有合法的在跑 run，
 * 所以任何带标记的进程都是上一个进程死掉留下的残留。
 */
export function findAnyTagged(entries: readonly ProcEntry[], excludePid?: number): number[] {
  const prefix = `${RUN_TAG_ENV}=`
  const hits: number[] = []
  for (const entry of entries) {
    if (excludePid !== undefined && entry.pid === excludePid) continue
    const vars = entry.environ.split('\0')
    if (isPm2Managed(vars)) continue
    if (vars.some((item) => item.startsWith(prefix) && item.length > prefix.length)) {
      hits.push(entry.pid)
    }
  }
  return hits
}

/**
 * 杀掉所有带该标记的进程。
 *
 * 顺序：先 SIGTERM 给一点时间体面退出，再 SIGKILL 收尸。
 * SIGTERM 之后不等待：残留进程本来就不该有优雅处理的机会，
 * 它们是被遗弃的，越快清掉越好。
 */
export function sweepRun(
  runId: string,
  options: {
    procRoot?: string
    kill?: (pid: number, signal: NodeJS.Signals) => void
    excludePid?: number
    table?: readonly ProcEntry[]
  } = {},
): SweepResult {
  const killFn = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const table = options.table ?? readProcTable(options.procRoot)
  const targets = findTagged(table, runId, options.excludePid)

  const killed: number[] = []
  const failed: number[] = []
  for (const pid of targets) {
    try {
      killFn(pid, 'SIGKILL')
      killed.push(pid)
    } catch (error) {
      // ESRCH 表示目标已经自己退出，这算清理成功，不是失败。
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') failed.push(pid)
    }
  }
  return { killed, failed }
}

/**
 * 启动时清场：杀掉所有带 DILEE_RUN_ID 标记的进程。
 *
 * 刚启动的进程不可能有合法在跑的 run，所以命中的都是上次进程退出时留下的残留。
 * 不清理的话，它们会一直吃 CPU，把后续每次 run 都拖慢。
 */
export function sweepStaleRuns(
  options: {
    procRoot?: string
    kill?: (pid: number, signal: NodeJS.Signals) => void
    excludePid?: number
    table?: readonly ProcEntry[]
  } = {},
): SweepResult {
  const killFn = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const table = options.table ?? readProcTable(options.procRoot)
  const targets = findAnyTagged(table, options.excludePid)

  const killed: number[] = []
  const failed: number[] = []
  for (const pid of targets) {
    try {
      killFn(pid, 'SIGKILL')
      killed.push(pid)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') failed.push(pid)
    }
  }
  return { killed, failed }
}
