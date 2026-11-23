/**
 * watchdog 的测试全部是「固定数组进、固定判定出」，不碰进程、不碰时钟、不碰文件。
 *
 * 为什么这一层要这样测：看门狗的价值在于**边界**——「12 分钟没事件但 CPU 85%」到底是死锁还是
 * 在编译，「5 小时 30 分」该预告还是该沉默。这些边界只要有一处写反（`>` 写成 `>=`、
 * 「最近连续 N 个」写成「历史上任意 N 个」），线上表现就是「复杂任务被误杀」或
 * 「真死锁没人报」，而这两种故障都不会在短跑里自己冒出来。
 * 假进程/假时钟都只会验证「我以为是这么调的」，所以这里直接喂采样点。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_WATCHDOG_OPTIONS,
  describeVerdict,
  judge,
  needCeilingWarning,
  resolveWatchdogOptions,
} from '../src/watchdog.ts'
import type { ProgressSample } from '../src/watchdog.ts'

const START = Date.parse('2026-11-23T10:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** 一个采样点。默认是「健康」的：事件刚动过、CPU 有消耗、子进程在跑。 */
function sample(overrides: Partial<ProgressSample> = {}): ProgressSample {
  return {
    at: START,
    lastEventAgeMs: 20_000,
    cpuPercent: 40,
    maxChildCpuPercent: 12,
    toolCalls: 10,
    ...overrides,
  }
}

/** 三条全中的采样点：12 分钟没事件、进程 0.3% CPU、没有子进程在动。 */
function stuck(): ProgressSample {
  return sample({ lastEventAgeMs: 12 * MINUTE, cpuPercent: 0.3, maxChildCpuPercent: 0 })
}

test('空采样：判 alive（还没攒证据，不能凭没有数据报死锁）', () => {
  assert.equal(judge([], START + 5 * MINUTE, START), 'alive')
  assert.equal(judge([], START + 5 * MINUTE, START, { suspectStreak: 0 }), 'alive')
})

test('正常推进：事件间隔短、CPU 有消耗 → alive', () => {
  const samples = [sample(), sample({ at: START + MINUTE, lastEventAgeMs: 30_000 })]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'alive')
})

test('慢但活着：12 分钟没事件，但 CPU 85%（在编译）→ alive', () => {
  const busy = sample({ lastEventAgeMs: 12 * MINUTE, cpuPercent: 85, maxChildCpuPercent: 0 })
  const samples = [busy, { ...busy, at: START + MINUTE }]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'alive')
})

test('慢但活着：12 分钟没事件、进程 CPU 0.5%，但子进程 60%（在跑测试）→ alive', () => {
  const waiting = sample({ lastEventAgeMs: 12 * MINUTE, cpuPercent: 0.5, maxChildCpuPercent: 60 })
  const samples = [waiting, { ...waiting, at: START + MINUTE }]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'alive')
})

test('真疑似死锁：连续 2 个采样点三条件同时成立 → suspect', () => {
  const samples = [stuck(), { ...stuck(), at: START + MINUTE }]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'suspect')
})

test('只连续 1 个采样点成立 → 仍 alive（不足 streak）', () => {
  assert.equal(judge([stuck()], START + MINUTE, START), 'alive', '一个点不够，默认要 2 个')
  assert.equal(judge([sample(), { ...stuck(), at: START + MINUTE }], START + 2 * MINUTE, START), 'alive')
})

test('三条件只满足两个（事件停 12 分钟但 CPU 3%）→ alive', () => {
  const halfBusy = sample({ lastEventAgeMs: 12 * MINUTE, cpuPercent: 3, maxChildCpuPercent: 0 })
  const samples = [halfBusy, { ...halfBusy, at: START + MINUTE }]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'alive')
})

test('只取末尾 streak 个：早先卡住、后来动了 → alive', () => {
  const samples = [
    stuck(),
    { ...stuck(), at: START + MINUTE },
    sample({ at: START + 2 * MINUTE }),
    sample({ at: START + 3 * MINUTE, lastEventAgeMs: 40_000 }),
  ]
  assert.equal(judge(samples, START + 4 * MINUTE, START), 'alive')
})

test('到 6 小时硬顶 → ceiling（与采样无关）', () => {
  assert.equal(judge([], START + DEFAULT_WATCHDOG_OPTIONS.hardCeilingMs, START), 'ceiling', '正好到点就算到顶')
  assert.equal(judge([sample()], START + 6 * HOUR + MINUTE, START), 'ceiling')
  assert.notEqual(judge([sample()], START + 6 * HOUR - MINUTE, START), 'ceiling', '差一分钟还没到顶')
})

test('5 小时 29 分：非 ceiling，且不该预告', () => {
  const nowMs = START + 5 * HOUR + 29 * MINUTE
  assert.equal(judge([sample()], nowMs, START), 'alive')
  assert.equal(needCeilingWarning(nowMs, START), false)
})

test('5 小时 31 分：进入预告区间 → true，但仍非 ceiling', () => {
  const nowMs = START + 5 * HOUR + 31 * MINUTE
  assert.equal(needCeilingWarning(nowMs, START), true)
  assert.equal(judge([sample()], nowMs, START), 'alive', '预告不等于截断')
})

test('预告区间是左闭右开：正好 5 小时 30 分预告，到顶后不再预告', () => {
  assert.equal(needCeilingWarning(START + 5 * HOUR + 30 * MINUTE, START), true)
  assert.equal(needCeilingWarning(START + 6 * HOUR, START), false, '到顶交给 judge 判 ceiling')
  assert.equal(needCeilingWarning(START + 5 * HOUR + 29 * MINUTE + 59_000, START), false)
})

test('ceiling 优先于 suspect：两者同时成立时报 ceiling', () => {
  const samples = [stuck(), { ...stuck(), at: START + MINUTE }]
  assert.equal(judge(samples, START + 6 * HOUR, START), 'ceiling')
  assert.match(describeVerdict(judge(samples, START + 6 * HOUR, START), samples, START + 6 * HOUR, START), /绝对上限/)
})

test('阈值按文档取等号：事件正好 10 分钟算没进展，CPU 正好 3% / 子进程正好 5% 算有活动', () => {
  const atIdleEdge = sample({ lastEventAgeMs: 10 * MINUTE, cpuPercent: 0.9, maxChildCpuPercent: 0 })
  assert.equal(judge([atIdleEdge, { ...atIdleEdge, at: START + MINUTE }], START + 2 * MINUTE, START), 'suspect')
  // 地板 3%（真机实测：空转 node 约 1.6%，取 1% 会漏报）。「正好等于」算有活动 —— 严格小于才判死。
  const cpuEdge = sample({ lastEventAgeMs: 10 * MINUTE, cpuPercent: 3, maxChildCpuPercent: 0 })
  assert.equal(judge([cpuEdge, cpuEdge], START + 2 * MINUTE, START), 'alive', 'CPU 正好 3% 不算「没在干活」')
  const childEdge = sample({ lastEventAgeMs: 10 * MINUTE, cpuPercent: 0.5, maxChildCpuPercent: 5 })
  assert.equal(judge([childEdge, childEdge], START + 2 * MINUTE, START), 'alive', '子进程正好 5% 不算「没动」')
})

test('自定义 opts 生效：idleThresholdMs 1000 + suspectStreak 1', () => {
  const samples = [sample({ lastEventAgeMs: 1_500, cpuPercent: 0.2, maxChildCpuPercent: 0 })]
  assert.equal(judge(samples, START + MINUTE, START), 'alive', '默认要 10 分钟无事件，1.5 秒远远不够')
  assert.equal(judge(samples, START + MINUTE, START, { idleThresholdMs: 1_000, suspectStreak: 1 }), 'suspect')
})

test('自定义 opts 生效：cpuFloorPercent 调高后，同样读数会被判死', () => {
  const slow = sample({ lastEventAgeMs: 12 * MINUTE, cpuPercent: 3, maxChildCpuPercent: 0 })
  const samples = [slow, { ...slow, at: START + MINUTE }]
  assert.equal(judge(samples, START + 2 * MINUTE, START), 'alive', '默认地板 3%，3% 正好算有消耗')
  assert.equal(judge(samples, START + 2 * MINUTE, START, { cpuFloorPercent: 10 }), 'suspect')
})

test('自定义 opts 生效：hardCeilingMs 缩短到 10 秒', () => {
  assert.equal(judge([], START + 10_000, START, { hardCeilingMs: 10_000 }), 'ceiling')
  assert.equal(judge([], START + 9_999, START, { hardCeilingMs: 10_000 }), 'alive')
})

test('describeVerdict：三种判定各说各的话，且不含 markdown 表格', () => {
  const samples = [stuck(), { ...stuck(), at: START + MINUTE }]
  const nowMs = START + 2 * MINUTE

  const alive = describeVerdict('alive', [sample()], nowMs, START)
  assert.match(alive, /仍在推进/)
  assert.match(alive, /CPU 40%/, '整数不拖 .0')

  const suspect = describeVerdict('suspect', samples, nowMs, START)
  assert.match(suspect, /疑似死锁/)
  assert.match(suspect, /12 分钟/, '要说出多久没事件进展')
  assert.match(suspect, /CPU 0\.3%/, '0.3% 与 0% 是两个结论，小数不能丢')
  assert.match(suspect, /无子进程活动/)
  assert.match(suspect, /继续/, '要给出可回复的动作')

  const ceiling = describeVerdict('ceiling', samples, START + 6 * HOUR, START)
  assert.match(ceiling, /已到绝对上限 6 小时/)
  assert.match(ceiling, /6 小时/)

  for (const text of [alive, suspect, ceiling]) {
    assert.equal(text.includes('|'), false, '群里播报只用一行，不出表格')
    assert.equal(text.includes('\n'), false, '必须是单行')
  }
})

test('describeVerdict：没有采样点也能播报（刚开工/采样还没回来）', () => {
  assert.match(describeVerdict('alive', [], START + MINUTE, START), /还没有采样数据/)
  assert.match(describeVerdict('suspect', [], START + MINUTE, START), /疑似死锁/)
  assert.match(describeVerdict('ceiling', [], START + 6 * HOUR, START), /绝对上限/)
})

test('resolveWatchdogOptions：默认值就是文档里那七个数，可覆盖，异常值退回默认', () => {
  assert.deepEqual(resolveWatchdogOptions(), DEFAULT_WATCHDOG_OPTIONS)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.sampleIntervalMs, 60_000, '调度方用它排定时器')
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.idleThresholdMs, 10 * MINUTE)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.cpuFloorPercent, 3)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.childCpuFloorPercent, 5)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.suspectStreak, 2)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.hardCeilingMs, 6 * HOUR)
  assert.equal(DEFAULT_WATCHDOG_OPTIONS.ceilingWarnMs, 30 * MINUTE)

  assert.equal(resolveWatchdogOptions({ hardCeilingMs: 1_000 }).hardCeilingMs, 1_000)
  assert.equal(resolveWatchdogOptions({ hardCeilingMs: Number.NaN }).hardCeilingMs, 6 * HOUR, 'NaN 不该让判据恒 false')
  assert.equal(resolveWatchdogOptions({ suspectStreak: 0 }).suspectStreak, 1, '0 会让「最近连续 N 个」变成「历史上任意个」')
})
