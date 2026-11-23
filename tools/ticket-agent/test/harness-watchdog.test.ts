/**
 * 看门狗在运行器这一侧的接线：切断的 run 一律不算完成、读不到 CPU 就交白卷。
 *
 * 为什么这些断言必须存在：2026-11-23 的 T-0027 就是被「收到 SIGTERM 后退出码 0」
 * 判成了 completed，于是只完成 40% 的改动被推进 `gated`（可部署）。
 * 这一层的契约只有一条 —— **切断 ≠ 完成**。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  runHarness,
  outcomeForStop,
  type HarnessWatchdog,
} from '../src/harness-runner.ts'

/** 写一个假 dsh：先吐事件，然后一直挂着，直到被打断。 */
function fakeHangingDsh(dir: string, exitOnTerm = 0): string {
  const script = join(dir, 'hang.mjs')
  writeFileSync(
    script,
    `
      process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's-wd' }) + '\\n')
      process.stdout.write(JSON.stringify({ type: 'text', text: '做到一半' }) + '\\n')
      process.on('SIGTERM', () => process.exit(${exitOnTerm}))
      setInterval(() => {}, 1000)
    `,
  )
  return script
}

function sandbox(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-wd-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── 纯判定：把「怎么收的尾」映射成结果 ────────────────────────────────────────

test('outcomeForStop：收到 SIGTERM 后正常退出是 truncated，不是 completed', () => {
  assert.equal(outcomeForStop({ stopCause: 'ceiling', softStopped: true, code: 0 }), 'truncated')
  assert.equal(outcomeForStop({ stopCause: 'abort', softStopped: true, code: 0 }), 'truncated')
})

test('outcomeForStop：只能强杀 / 没打招呼直接杀都是 timeout', () => {
  assert.equal(outcomeForStop({ stopCause: 'ceiling', softStopped: true, code: null }), 'timeout')
  assert.equal(outcomeForStop({ stopCause: 'ceiling', softStopped: false, code: 137 }), 'timeout')
  assert.equal(outcomeForStop({ stopCause: 'abort', softStopped: true, code: 1 }), 'timeout')
})

// ── 端到端：被切断的 run 不许报 completed ─────────────────────────────────────

test('到绝对上限：结果绝不是 completed（T-0027 的教训）', { timeout: 30_000 }, async () => {
  const box = sandbox()
  try {
    const result = await runHarness({
      dshBin: fakeHangingDsh(box.dir),
      nodePath: process.execPath,
      cwd: box.dir,
      prompt: 'x',
      timeoutMs: 900,
      graceMs: 400,
    })
    assert.notEqual(result.outcome, 'completed', '被切断的 run 绝不能报 completed')
    assert.ok(
      result.outcome === 'truncated' || result.outcome === 'timeout',
      `只该是 truncated 或 timeout，实际 ${result.outcome}`,
    )
    assert.match(result.error ?? '', /未完成|强制终止/, 'error 要说明它没干完')
  } finally {
    box.done()
  }
})

test('用户叫停：结果绝不是 completed，且能看出是谁叫停的', { timeout: 30_000 }, async () => {
  const box = sandbox()
  const controller = new AbortController()
  try {
    const pending = runHarness({
      dshBin: fakeHangingDsh(box.dir),
      nodePath: process.execPath,
      cwd: box.dir,
      prompt: 'x',
      // 上限放到很大：这次唯一的结束原因是 abort
      timeoutMs: 60_000,
      graceMs: 300,
      abortSignal: controller.signal,
    })
    setTimeout(() => controller.abort(), 500)
    const result = await pending
    assert.notEqual(result.outcome, 'completed')
    assert.match(result.error ?? '', /用户选择截断/, 'error 要写明是用户叫停的')
  } finally {
    box.done()
  }
})

// ── 看门狗回调：只报告，不杀 ─────────────────────────────────────────────────

test('看门狗：事件静止 + CPU 空闲 + 无子进程 → 触发 onSuspect（但不会杀进程）', { timeout: 30_000 }, async () => {
  const box = sandbox()
  const notices: string[] = []
  let readCount = 0
  const watchdog: HarnessWatchdog = {
    // 采样间隔压到 40ms，判定要求「事件静止 120ms」，两个采样点即达标
    options: { sampleIntervalMs: 40, idleThresholdMs: 120, suspectStreak: 2 },
    readCpu: () => {
      readCount += 1
      return { cpuPercent: 0.3, maxChildCpuPercent: 0 }
    },
    onSuspect: (info) => notices.push(info.description),
  }
  try {
    const pending = runHarness({
      dshBin: fakeHangingDsh(box.dir),
      nodePath: process.execPath,
      cwd: box.dir,
      prompt: 'x',
      timeoutMs: 1_500,
      graceMs: 300,
      watchdog,
    })
    const result = await pending
    assert.ok(readCount >= 2, `看门狗应该被采样过，实际 ${readCount} 次`)
    assert.ok(notices.length >= 1, '应至少报一次疑似死锁')
    assert.match(notices[0], /疑似死锁/, '文案要说人话')
    // 关键：它只是报告，进程是撞到绝对上限才收的
    assert.notEqual(result.outcome, 'completed')
    assert.match(result.error ?? '', /绝对上限/, '收口原因应是绝对上限，而不是看门狗主动杀')
  } finally {
    box.done()
  }
})

test('看门狗：读不到 CPU（返回 null）时一次都不报（宁可漏报，不可误报）', { timeout: 30_000 }, async () => {
  const box = sandbox()
  let judged = 0
  const watchdog: HarnessWatchdog = {
    options: { sampleIntervalMs: 40, idleThresholdMs: 120, suspectStreak: 2 },
    readCpu: () => {
      judged += 1
      return null
    },
    onSuspect: () => assert.fail('读不到 CPU 时绝不能报疑似死锁'),
  }
  try {
    const result = await runHarness({
      dshBin: fakeHangingDsh(box.dir),
      nodePath: process.execPath,
      cwd: box.dir,
      prompt: 'x',
      timeoutMs: 800,
      graceMs: 300,
      watchdog,
    })
    assert.ok(judged >= 1, '采样器应该被调用过')
    assert.notEqual(result.outcome, 'completed')
  } finally {
    box.done()
  }
})

test('看门狗：快到绝对上限时预告一次，且只预告一次', { timeout: 30_000 }, async () => {
  const box = sandbox()
  const warnings: string[] = []
  const watchdog: HarnessWatchdog = {
    // 上限 1000ms、提前 700ms 预告 → 第 300ms 进入预告区间
    options: { sampleIntervalMs: 50, hardCeilingMs: 1_000, ceilingWarnMs: 700, idleThresholdMs: 60_000 },
    readCpu: () => ({ cpuPercent: 42, maxChildCpuPercent: 42 }),
    onCeilingWarning: (info) => warnings.push(info.description),
  }
  try {
    await runHarness({
      dshBin: fakeHangingDsh(box.dir),
      nodePath: process.execPath,
      cwd: box.dir,
      prompt: 'x',
      timeoutMs: 1_000,
      graceMs: 300,
      watchdog,
    })
    assert.equal(warnings.length, 1, `预告应只发一次，实际 ${warnings.length} 次`)
  } finally {
    box.done()
  }
})
