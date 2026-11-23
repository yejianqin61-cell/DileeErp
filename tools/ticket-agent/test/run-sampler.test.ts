/**
 * 采样层的测试全部用**假 /proc**（临时目录里造 `<pid>/environ` 与 `<pid>/stat`），
 * 不读真 /proc、不依赖平台、不 sleep、不碰真进程。
 *
 * 为什么必须造真文件而不是打桩 `readFileSync`：这一层唯一容易错的东西就是 /proc 的**文件格式**
 * —— stat 第 2 字段 `comm` 带空格、environ 是 NUL 分隔、tick 在第 14/15 字段。
 * 打桩等于把「我以为的格式」当成真相，线上表现就是「CPU 永远是 0% → 看门狗把一个正在跑
 * vitest 的 run 判成死锁」。假目录至少能让格式错误在 CI 里暴露出来。
 *
 * 时间也全部注入（`now`），因为百分比是「tick 差 / 墙钟差」，
 * 真等一秒会让每条断言都绑上机器负载。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RUN_TAG_ENV } from '../src/run-janitor.ts'
import { RunSampler, percentBetween, readCpuTicks, sumCpuTicks } from '../src/run-sampler.ts'

/** environ 是 NUL 分隔的 KEY=VALUE 列表（末尾也有 NUL，和真 /proc 一样）。 */
function env(...vars: string[]): string {
  return vars.join('\0') + '\0'
}

interface StatTicks {
  readonly utime?: number
  readonly stime?: number
  readonly cutime?: number
  readonly cstime?: number
}

/**
 * 一行 `/proc/<pid>/stat`。
 *
 * 字段顺序（1 起）：1 pid、(comm) 2、3 state、4 ppid、5 pgrp、6 session、7 tty_nr、
 * 8 tpgid、9 flags、10 minflt、11 cminflt、12 majflt、13 cmajflt、14 utime、15 stime、
 * 16 cutime、17 cstime。第 3 字段起 `comm` 之后那 15 项按顺序给全，
 * 这样 utime/stime 落在「最后一个 `)` 之后」的下标 11/12 —— 与实现里的解析口径一致。
 */
function statLine(pid: number, ticks: StatTicks, comm: string): string {
  const afterComm = [
    'S', //  3 state
    '1', //  4 ppid
    '1', //  5 pgrp
    '1', //  6 session
    '0', //  7 tty_nr
    '-1', // 8 tpgid
    '0', //  9 flags
    '0', // 10 minflt
    '0', // 11 cminflt
    '0', // 12 majflt
    '0', // 13 cmajflt
    String(ticks.utime ?? 0), // 14
    String(ticks.stime ?? 0), // 15
    String(ticks.cutime ?? 0), // 16
    String(ticks.cstime ?? 0), // 17
  ]
  return `${pid} (${comm}) ${afterComm.join(' ')}\n`
}

interface FakeProc {
  readonly root: string
  /** 写/覆盖一个进程。`environ` 不传则保留原文件（模拟「只改 tick」）。 */
  put(pid: number, options?: StatTicks & { environ?: string; comm?: string }): void
  /** 只改 tick：模拟「这一段墙钟里它干活了」。 */
  setTicks(pid: number, utime: number, stime?: number): void
  dispose(): void
}

function createFakeProc(): FakeProc {
  const root = mkdtempSync(join(tmpdir(), 'dilee-run-sampler-'))
  const comms = new Map<number, string>()

  const put: FakeProc['put'] = (pid, options = {}) => {
    const comm = options.comm ?? comms.get(pid) ?? 'node'
    comms.set(pid, comm)
    mkdirSync(join(root, String(pid)), { recursive: true })
    if (options.environ !== undefined) {
      writeFileSync(join(root, String(pid), 'environ'), options.environ)
    }
    writeFileSync(join(root, String(pid), 'stat'), statLine(pid, options, comm))
  }

  return {
    root,
    put,
    setTicks(pid, utime, stime = 0) {
      put(pid, { utime, stime })
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 假目录用完即删，即使断言失败也不留垃圾。 */
function withFakeProc(run: (proc: FakeProc) => void): void {
  const proc = createFakeProc()
  try {
    run(proc)
  } finally {
    proc.dispose()
  }
}

/** 假时钟：手动推进，不让测试绑上真实耗时。 */
function clockAt(startMs = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

// ---------------------------------------------------------------- percentBetween

test('percentBetween 正常换算：1000ms 内 delta 100 ticks、HZ=100 → 100%', () => {
  // 100 ticks = 1 CPU·秒，窗口 1 秒 → 正好占满一个核。
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 100 }), 100)
})

test('percentBetween 按窗口长度缩放：同样的 delta，窗口越长百分比越低', () => {
  // 这条能抓住「忘了乘 100」和「忘了除 clockSeconds」；也确认结果可以超过 100%。
  assert.equal(percentBetween({ atMs: 1_000, ticks: 500 }, { atMs: 2_000, ticks: 550 }), 50)
  assert.equal(percentBetween({ atMs: 1_000, ticks: 500 }, { atMs: 3_000, ticks: 550 }), 25)
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 200 }), 200, '两个核 → 200%，不截到 100')
})

test('percentBetween 边界：deltaMs=0 / deltaTicks=0 / 负数 → 都返回 0', () => {
  assert.equal(percentBetween({ atMs: 1_000, ticks: 10 }, { atMs: 1_000, ticks: 110 }), 0, '同一时刻：除零不给 Infinity')
  assert.equal(percentBetween({ atMs: 0, ticks: 10 }, { atMs: 1_000, ticks: 10 }), 0, 'tick 没涨 → 0')
  assert.equal(percentBetween({ atMs: 0, ticks: 100 }, { atMs: 1_000, ticks: 40 }), 0, '计数器回绕/换了一批进程 → 0')
  assert.equal(percentBetween({ atMs: 2_000, ticks: 0 }, { atMs: 1_000, ticks: 500 }), 0, '时钟倒退 → 0')
})

test('percentBetween 夹在 [0, 100*100]：异常大的 delta 变上限，不是 Infinity/NaN', () => {
  const capped = percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1, ticks: 1e12 })
  assert.equal(capped, 10_000)
  assert.ok(Number.isFinite(capped))
  // NaN 进得去也算 0，别让 NaN 流进判定层（NaN < 阈值恒 false，会静默把卡死判成活着）。
  assert.equal(percentBetween({ atMs: Number.NaN, ticks: 0 }, { atMs: 1_000, ticks: 10 }), 0)
})

test('percentBetween 支持自定义 clockSeconds，非法值退回默认 HZ=100', () => {
  // CONFIG_HZ_1000 的机器：1000 tick 才是 1 CPU·秒。
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 1_000 }, 1_000), 100)
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 100 }, 0), 100, '0 会导致除零 → 退回默认')
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 100 }, -5), 100)
  assert.equal(percentBetween({ atMs: 0, ticks: 0 }, { atMs: 1_000, ticks: 100 }, Number.NaN), 100)
})

// ---------------------------------------------------------------- readCpuTicks / sumCpuTicks

test('readCpuTicks 把 utime+stime+cutime+cstime 全部相加', () => {
  withFakeProc((proc) => {
    proc.put(1234, { utime: 10, stime: 5, cutime: 3, cstime: 2 })
    assert.equal(readCpuTicks(1234, proc.root), 20)
  })
})

test('readCpuTicks 对 comm 含空格与括号的 stat 也能找准 utime/stime', () => {
  withFakeProc((proc) => {
    // 真实现场：`node /opt/erp worker (v2)`、`sh -c 'exec 1)'` 这种名字。
    // 按空格切整行会在这里错位，把 state 之后的某个计数当成 utime，CPU 就永远是错的。
    proc.put(2001, { utime: 40, stime: 2, comm: 'node /opt/erp worker (v2)' })
    assert.equal(readCpuTicks(2001, proc.root), 42)
  })
})

test('readCpuTicks 读不到 → null：缺文件、字段不全、proc 根不存在', () => {
  withFakeProc((proc) => {
    proc.put(3001, { utime: 7 })
    assert.equal(readCpuTicks(3002, proc.root), null, '目录都没有')

    // 截断的 stat：宁可当读不到，也不要拿半份数据算出偏小的 tick（那会伪装成「CPU 很低」）。
    writeFileSync(join(proc.root, '3001', 'stat'), '1234 (node) S\n')
    assert.equal(readCpuTicks(3001, proc.root), null)

    writeFileSync(join(proc.root, '3001', 'stat'), 'not a stat line\n')
    assert.equal(readCpuTicks(3001, proc.root), null, '没有 ) → 解析不了')
  })
  // macOS/Windows：根本没有 /proc。这条路径必须安静地给 null。
  assert.equal(readCpuTicks(process.pid, '/proc-does-not-exist-xyz'), null)
  assert.equal(readCpuTicks(process.pid, join(tmpdir(), 'dilee-sampler-nope-xyz')), null)
})

test('sumCpuTicks 多个 pid，其中一个读不到 → 只加读得到的', () => {
  withFakeProc((proc) => {
    proc.put(100, { utime: 10 })
    proc.put(101, { utime: 25, stime: 5 })
    // 102 不存在（采样瞬间刚退出）：跳过，不是错误。
    assert.equal(sumCpuTicks([100, 101, 102], proc.root), 40)
    assert.equal(sumCpuTicks([], proc.root), 0)
    assert.equal(sumCpuTicks([999], '/proc-does-not-exist-xyz'), 0)
  })
})

// ---------------------------------------------------------------- RunSampler

test('RunSampler 首次采样只建基线（0%），之后按子树 tick 差算总百分比', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    // 主进程故意不带标记：它仍要进 processCount 与 totalPercent。
    proc.put(1000, { utime: 100, environ: env('PATH=/usr/bin') })
    // 子进程（比如 dsh 起的 tsc）带本次 run 的标记。
    proc.put(1001, { utime: 0, environ: env('PATH=/usr/bin', `${RUN_TAG_ENV}=run-a`) })

    const sampler = new RunSampler({
      runId: 'run-a',
      mainPid: 1000,
      procRoot: proc.root,
      clockSeconds: 100,
      now: clock.now,
    })

    const first = sampler.sample()
    assert.equal(first.totalPercent, 0, '没有上一次 tick 就没有 delta')
    assert.equal(first.busiestChildPercent, 0)
    assert.equal(first.atMs, 1_000)
    assert.equal(first.processCount, 2, '主进程 + 一个子孙')

    // 一个 1 秒的窗口：主进程涨 50 ticks、子进程涨 10 ticks（HZ=100 → 50% / 10%）。
    clock.advance(1_000)
    proc.setTicks(1000, 150)
    proc.setTicks(1001, 10)

    const second = sampler.sample()
    assert.equal(second.totalPercent, 60, '两个进程相加')
    assert.equal(second.busiestChildPercent, 10, 'maxChild 只取子进程，不含主进程那 50%')
    assert.equal(second.processCount, 2)
  })
})

test('RunSampler 的 busiestChildPercent 取子进程里的峰值', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    const tagged = env(`PATH=/usr/bin`, `${RUN_TAG_ENV}=run-b`)
    proc.put(2000, { utime: 0, environ: tagged })
    proc.put(2001, { utime: 0, environ: tagged })
    proc.put(2002, { utime: 0, environ: tagged })

    const sampler = new RunSampler({ runId: 'run-b', mainPid: 2000, procRoot: proc.root, now: clock.now })
    assert.equal(sampler.sample().processCount, 3, '主进程同时在 findTagged 里，不能重复计数')

    clock.advance(1_000)
    proc.setTicks(2000, 1) // 主进程 1%
    proc.setTicks(2001, 7) // 7%
    proc.setTicks(2002, 90) // 90% → 峰值

    const snapshot = sampler.sample()
    assert.equal(snapshot.busiestChildPercent, 90)
    assert.equal(snapshot.totalPercent, 98)
  })
})

test('RunSampler 按注入的 clockSeconds 换算（HZ=1000 的机器）', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    proc.put(2500, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-hz`) })
    const sampler = new RunSampler({
      runId: 'run-hz',
      mainPid: 2500,
      procRoot: proc.root,
      clockSeconds: 1_000,
      now: clock.now,
    })
    sampler.sample()

    clock.advance(1_000)
    proc.setTicks(2500, 100) // 100/1000 = 0.1 CPU·秒 → 10%
    assert.equal(sampler.sample().totalPercent, 10)
  })
})

test('RunSampler.reset() 之后第一帧又回到 0（用户回「继续」后重新计时）', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    proc.put(1000, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-r`) })
    const sampler = new RunSampler({ runId: 'run-r', mainPid: 1000, procRoot: proc.root, now: clock.now })

    sampler.sample()
    clock.advance(1_000)
    proc.setTicks(1000, 100)
    assert.equal(sampler.sample().totalPercent, 100)

    sampler.reset()
    clock.advance(1_000)
    proc.setTicks(1000, 400) // 空转的 300 ticks 不该算进新窗口
    assert.equal(sampler.sample().totalPercent, 0)
    assert.equal(sampler.sample().busiestChildPercent, 0)

    clock.advance(1_000)
    proc.setTicks(1000, 450)
    assert.equal(sampler.sample().totalPercent, 50, '新基线之后重新开始算')
  })
})

test('procRoot 不存在（macOS/Windows）：sample() 不抛异常，返回全 0', () => {
  const sampler = new RunSampler({ runId: 'run-x', mainPid: 4242, procRoot: '/proc-does-not-exist-xyz' })
  const first = sampler.sample()
  assert.equal(first.totalPercent, 0)
  assert.equal(first.busiestChildPercent, 0)
  // processCount=0 就是「这一轮没读到 CPU」的信号；判定层靠它区分「读不到」与「真的空闲」。
  assert.equal(first.processCount, 0)

  const second = sampler.sample()
  assert.equal(second.totalPercent, 0)
  assert.equal(second.processCount, 0)
  sampler.reset()
  assert.equal(sampler.sample().totalPercent, 0)
})

test('只算精确匹配的标记：别的 run id、前缀相同的 id、PM2 托管进程都不进这棵树', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    proc.put(3000, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-a`) }) // 本次 run
    proc.put(3001, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-b`) }) // 别人的 run
    proc.put(3002, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-a-extra`) }) // 前缀陷阱
    // 2026-11-16 线上事故的形态：部署脚本 pm2 start 继承了 DILEE_RUN_ID，
    // 生产应用（dilee-api / dilee-web）也带上了标记。它们的 CPU 不属于这个 run。
    proc.put(3003, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-a`, 'pm_id=4', 'name=dilee-api') })

    const sampler = new RunSampler({ runId: 'run-a', mainPid: 3000, procRoot: proc.root, now: clock.now })
    assert.equal(sampler.sample().processCount, 1, '只有主进程')

    clock.advance(1_000)
    proc.setTicks(3000, 20)
    proc.setTicks(3001, 80)
    proc.setTicks(3002, 80)
    proc.setTicks(3003, 80)

    const snapshot = sampler.sample()
    assert.equal(snapshot.processCount, 1)
    assert.equal(snapshot.totalPercent, 20, '只有主进程自己的 tick')
    assert.equal(snapshot.busiestChildPercent, 0, '被排除的进程也不能冒充 maxChild')
  })
})

test('本窗口才出现的进程本窗口不给百分比：不把它的累计 tick 当成本窗口增量', () => {
  withFakeProc((proc) => {
    const clock = clockAt()
    proc.put(4000, { utime: 0, environ: env(`${RUN_TAG_ENV}=run-n`) })
    const sampler = new RunSampler({ runId: 'run-n', mainPid: 4000, procRoot: proc.root, clockSeconds: 100, now: clock.now })
    sampler.sample()

    clock.advance(1_000)
    proc.setTicks(4000, 5)
    // 新起的子进程，累计 900 ticks —— 那是它自己的一生，不是这一秒的增量。
    proc.put(4001, { utime: 900, environ: env(`${RUN_TAG_ENV}=run-n`) })

    const snapshot = sampler.sample()
    assert.equal(snapshot.processCount, 2)
    assert.equal(snapshot.busiestChildPercent, 0, '没有基线 → 这个窗口不给它百分比')
    // 聚合值仍会把新进程的累计 tick 一次性并进来（因此这里 > 0，并被 MAX_PERCENT 夹住）。
    // 方向是「看起来在忙」，不会伪造出 CPU=0 的死锁证据；maxChild 没有这个问题。
    assert.ok(Number.isFinite(snapshot.totalPercent) && snapshot.totalPercent > 0)
  })
})
