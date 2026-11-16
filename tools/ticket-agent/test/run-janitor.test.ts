import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUN_TAG_ENV,
  findAnyTagged,
  findTagged,
  readProcTable,
  sweepRun,
  sweepStaleRuns,
  type ProcEntry,
} from '../src/run-janitor.ts'

/** environ 是 NUL 分隔的 KEY=VALUE 列表。 */
function env(...vars: string[]): string {
  return vars.join('\0') + '\0'
}

function table(...rows: Array<[number, string]>): ProcEntry[] {
  return rows.map(([pid, environ]) => ({ pid, environ }))
}

test('findTagged 只命中带指定 run id 的进程', () => {
  const entries = table(
    [100, env('PATH=/usr/bin', `${RUN_TAG_ENV}=run-a`)],
    [101, env('PATH=/usr/bin', `${RUN_TAG_ENV}=run-b`)],
    [102, env('PATH=/usr/bin')],
  )
  assert.deepEqual(findTagged(entries, 'run-a'), [100])
  assert.deepEqual(findTagged(entries, 'run-b'), [101])
  assert.deepEqual(findTagged(entries, 'run-c'), [])
})

test('findTagged 不误伤前缀相同的 id（run-a 不应命中 run-ab）', () => {
  const entries = table([200, env(`${RUN_TAG_ENV}=run-ab`)])
  assert.deepEqual(findTagged(entries, 'run-a'), [])
  assert.deepEqual(findTagged(entries, 'run-ab'), [200])
})

test('findTagged 排除自身 pid', () => {
  const entries = table(
    [100, env(`${RUN_TAG_ENV}=r`)],
    [101, env(`${RUN_TAG_ENV}=r`)],
  )
  assert.deepEqual(findTagged(entries, 'r', 100), [101])
})

test('findAnyTagged 命中任意 run id，但不命中无关进程', () => {
  const entries = table(
    [1, env('PATH=/x')],
    [2, env(`${RUN_TAG_ENV}=old-run`)],
    [3, env(`${RUN_TAG_ENV}=another`)],
    [4, env('DILEE_OTHER=1')],
  )
  assert.deepEqual(findAnyTagged(entries), [2, 3])
})

test('空的标记值不算（避免误杀只是定义了空变量的进程）', () => {
  const entries = table([5, env(`${RUN_TAG_ENV}=`)])
  assert.deepEqual(findAnyTagged(entries), [])
})

test('PM2 托管的进程永远不杀：即使它带着 DILEE_RUN_ID', () => {
  // 2026-11-16 真实事故：部署脚本的 pm2 start 从命令行继承了 DILEE_RUN_ID，
  // 于是 dilee-api / dilee-web 也带上了标记，机器人重启清场时把它们 SIGKILL 了。
  const entries = table(
    [600, env(`${RUN_TAG_ENV}=leaked`, 'pm_id=4', 'name=dilee-api', 'PM2_HOME=/home/ubuntu/.pm2')],
    [601, env(`${RUN_TAG_ENV}=leaked`, 'PM2_HOME=/home/ubuntu/.pm2')],
    [602, env(`${RUN_TAG_ENV}=leaked`)],
  )
  assert.deepEqual(findAnyTagged(entries), [602], '只杀非 PM2 托管的残留')
  assert.deepEqual(findTagged(entries, 'leaked'), [602])
  const killed: number[] = []
  sweepStaleRuns({ table: entries, kill: (pid) => killed.push(pid) })
  assert.deepEqual(killed, [602])
})

test('sweepRun 用注入的 kill 记录目标，不碰真实进程', () => {
  const entries = table(
    [300, env(`${RUN_TAG_ENV}=run-x`)],
    [301, env(`${RUN_TAG_ENV}=run-y`)],
  )
  const killed: number[] = []
  const result = sweepRun('run-x', {
    table: entries,
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [300])
  assert.deepEqual(result.killed, [300])
  assert.deepEqual(result.failed, [])
})

test('ESRCH 视为成功（进程已自己退出），其他错误记为失败', () => {
  const entries = table(
    [400, env(`${RUN_TAG_ENV}=r`)],
    [401, env(`${RUN_TAG_ENV}=r`)],
  )
  const result = sweepRun('r', {
    table: entries,
    kill: (pid) => {
      if (pid === 400) {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      }
      const error = new Error('denied') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    },
  })
  assert.deepEqual(result.killed, [])
  assert.deepEqual(result.failed, [401], 'ESRCH 不算失败，EPERM 算')
})

test('sweepStaleRuns 清掉所有旧标记，含不同 run id', () => {
  const entries = table(
    [500, env(`${RUN_TAG_ENV}=old-1`)],
    [501, env(`${RUN_TAG_ENV}=old-2`)],
    [502, env('PATH=/x')],
  )
  const killed: number[] = []
  const result = sweepStaleRuns({ table: entries, kill: (pid) => killed.push(pid) })
  assert.deepEqual(killed.sort(), [500, 501])
  assert.equal(result.killed.length, 2)
})

test('readProcTable 在真实 /proc 上不崩，且至少能读到当前进程', { skip: process.platform !== 'linux' ? '/proc 仅 Linux 有' : false }, () => {
  const entries = readProcTable()
  assert.ok(entries.length > 0, '应能读到进程表')
  const self = entries.find((entry) => entry.pid === process.pid)
  assert.ok(self !== undefined, '应能读到自身')
})

test('readProcTable 对不存在的 procRoot 返回空数组而不抛错', () => {
  assert.deepEqual(readProcTable('/proc-does-not-exist-xyz'), [])
})
