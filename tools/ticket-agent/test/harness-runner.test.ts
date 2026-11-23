import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildArgs,
  countEvents,
  extractFinalText,
  extractSessionId,
  buildTimeoutHandover,
  type HarnessEvent,
  parseEventLine,
  runHarness,
} from '../src/harness-runner.ts'

test('首轮不带 --session-id', () => {
  const args = buildArgs({ prompt: 'x' })
  assert.ok(!args.includes('--session-id'))
  assert.ok(args.includes('--json'))
  assert.ok(args.includes('headless'))
  assert.equal(args[args.length - 1], '-', 'prompt 应走 stdin')
})

test('续接轮带 --session-id 与 id 值', () => {
  const args = buildArgs({ prompt: 'x', sessionId: 'session-abc' })
  const index = args.indexOf('--session-id')
  assert.ok(index >= 0)
  assert.equal(args[index + 1], 'session-abc')
})

test('空 sessionId 视同未提供，不产出空参数', () => {
  const args = buildArgs({ prompt: 'x', sessionId: '' })
  assert.ok(!args.includes('--session-id'))
})

test('审批策略固定 never，沙箱固定 workspace-write', () => {
  const args = buildArgs({ prompt: 'x' })
  assert.equal(args[args.indexOf('--approval-policy') + 1], 'never')
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'workspace-write')
})

test('解析 NDJSON：合法行被解析，垃圾行返回 null', () => {
  assert.deepEqual(parseEventLine('{"type":"session","sessionId":"s1"}'), {
    type: 'session',
    sessionId: 's1',
  })
  assert.equal(parseEventLine(''), null)
  assert.equal(parseEventLine('   '), null)
  assert.equal(parseEventLine('not json'), null)
  assert.equal(parseEventLine('{"no":"type"}'), null)
  assert.equal(parseEventLine('[1,2,3]'), null)
})

test('抽取 sessionId：只认 session 事件', () => {
  const events = [
    { type: 'status', status: 'running' },
    { type: 'session', sessionId: 'session-x' },
  ]
  assert.equal(extractSessionId(events), 'session-x')
  assert.equal(extractSessionId([{ type: 'text', text: 'hi' }]), null)
  assert.equal(extractSessionId([]), null)
})

test('抽取 final 文本：取最后一个 final', () => {
  const events = [
    { type: 'final', text: '第一次' },
    { type: 'text', text: '中间' },
    { type: 'final', text: '最后一次' },
  ]
  assert.equal(extractFinalText(events), '最后一次')
  assert.equal(extractFinalText([]), '')
})

test('统计工具调用与 subagent 调用', () => {
  const events = [
    { type: 'tool_call', name: 'bash' },
    { type: 'tool_call', name: 'tool-subagent' },
    { type: 'tool_call', name: 'subagent-control' },
    { type: 'text', text: 'a' },
    { type: 'final', text: 'b' },
  ]
  assert.deepEqual(countEvents(events), { toolCalls: 3, subagentCalls: 2, textEvents: 1 })
})

/** 写一个假的 dsh 可执行脚本，用来测运行器而不真跑模型。 */
function fakeDsh(dir: string, script: string): string {
  const path = join(dir, 'fake-dsh.mjs')
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
  return path
}

test('成功的 run：捕获 sessionId 与 final 文本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      const lines = [
        { type: 'session', sessionId: 'session-fake-1' },
        { type: 'status', status: 'running' },
        { type: 'tool_call', name: 'bash' },
        { type: 'tool_call', name: 'tool-subagent' },
        { type: 'text', text: '改好了' },
        { type: 'final', text: '最终结论：已修复' },
      ];
      for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
      process.exit(0);
    `)
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: '测试',
      timeoutMs: 10_000,
    })

    assert.equal(result.outcome, 'completed')
    assert.equal(result.sessionId, 'session-fake-1')
    assert.equal(result.finalText, '最终结论：已修复')
    assert.equal(result.counts.toolCalls, 2)
    assert.equal(result.counts.subagentCalls, 1)
    assert.equal(result.exitCode, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prompt 通过 stdin 送入，脚本能读到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { input += c; });
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'final', text: 'len=' + input.length + ' has=' + input.includes('采购单') }) + '\\n');
        process.exit(0);
      });
    `)
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: '采购单列表页要能搜',
      timeoutMs: 10_000,
    })
    assert.equal(result.outcome, 'completed')
    assert.ok(result.finalText.includes('has=true'), `实际: ${result.finalText}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非零退出码 → failed，错误摘要来自 stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's' }) + '\\n');
      process.stderr.write('dsh: MISSING_CREDENTIAL: no API key\\n');
      process.exit(1);
    `)
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 10_000,
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.exitCode, 1)
    assert.ok(result.error?.includes('MISSING_CREDENTIAL'), `实际: ${result.error}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超时被强制终止 → timeout，不是 completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's-timeout' }) + '\\n');
      // 故意不退出
      setInterval(() => {}, 1000);
    `)
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 1200,
    })
    assert.equal(result.outcome, 'timeout')
    assert.ok(result.error?.includes('1200'), `实际: ${result.error}`)
    assert.equal(result.sessionId, 's-timeout', '超时前已捕获的会话 id 仍应返回')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('解释器不存在 → spawn-error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const result = await runHarness({
      dshBin: join(dir, 'any.mjs'),
      nodePath: join(dir, 'no-such-node'),
      cwd: dir,
      prompt: 'x',
      timeoutMs: 5_000,
    })
    assert.equal(result.outcome, 'spawn-error')
    assert.ok(result.error !== undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DSH 脚本不存在 → failed（解释器在，脚本不在）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const result = await runHarness({
      dshBin: join(dir, 'does-not-exist.mjs'),
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 10_000,
    })
    // node 能启动，但找不到模块，退出码 1。这是 failed 而不是 spawn-error。
    assert.equal(result.outcome, 'failed')
    assert.equal(result.exitCode, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onEvent 实时回调，且回调抛错不影响 run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      for (const line of [
        { type: 'session', sessionId: 's' },
        { type: 'text', text: 'a' },
        { type: 'final', text: 'done' },
      ]) process.stdout.write(JSON.stringify(line) + '\\n');
      process.exit(0);
    `)
    const seen: string[] = []
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 10_000,
      onEvent: (event) => {
        seen.push(event.type)
        if (event.type === 'text') throw new Error('回调故意抛错')
      },
    })
    assert.equal(result.outcome, 'completed')
    assert.deepEqual(seen, ['session', 'text', 'final'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('最后一行无换行符也能被解析', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-harness-'))
  try {
    const bin = fakeDsh(dir, `
      process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's' }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'final', text: 'no-newline-tail' }));
      process.exit(0);
    `)
    const result = await runHarness({
      dshBin: bin,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 10_000,
    })
    assert.equal(result.finalText, 'no-newline-tail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 软截止（2026-11-22）───────────────────────────────────────────────────────
// 用户原话：「tickbot 现在是 45 分钟没收口强制截断」。
// 这两条钉住：到点前先 SIGTERM 收口、并留下「做到哪了」的交接信息。

test('buildTimeoutHandover：有 text 事件时给出「工具调用次数 + 最后进展」', () => {
  const events: HarnessEvent[] = [
    { type: 'session', sessionId: 's1' },
    { type: 'tool_call', name: 'read' },
    { type: 'tool_call', name: 'subagent-worker' },
    { type: 'text', text: '正在改 order-workbench.service.ts' },
    { type: 'text', text: '已改完批量取数，正在跑测试' },
  ]
  const handover = buildTimeoutHandover(events)
  assert.match(handover, /工具 2 次/)
  assert.match(handover, /子 Agent 1 次/)
  assert.match(handover, /正在跑测试/, '应带上最后进展')
})

test('buildTimeoutHandover：没有 text 时至少报告工具调用次数（不能是空串）', () => {
  const events: HarnessEvent[] = [{ type: 'tool_call', name: 'read' }]
  const handover = buildTimeoutHandover(events)
  assert.equal(handover, '已调用工具 1 次（含子 Agent 0 次）')
  assert.ok(handover.length > 0)
})

test('buildTimeoutHandover：超长文本按尾部截断（保留最新的进展）', () => {
  const events: HarnessEvent[] = [{ type: 'text', text: `${'x'.repeat(1000)}关键结尾` }]
  const handover = buildTimeoutHandover(events, 50)
  assert.ok(handover.endsWith('关键结尾'), '应保留尾部而不是开头')
  assert.ok(handover.length < 200)
})

test('软截止：超过 timeoutMs 后结果为 timeout，且 error 里带交接摘要', { timeout: 30_000 }, async () => {
  // 用一个必然挂住的假 CLI：node -e 里 sleep，直到被信号打断
  const dir = mkdtempSync(join(tmpdir(), 'dilee-grace-'))
  const script = join(dir, 'hang.mjs')
  writeFileSync(script, `
    process.stdout.write(JSON.stringify({ type: 'session', sessionId: 's-grace' }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'text', text: '做到一半' }) + '\\n')
    setInterval(() => {}, 1000)
  `)
  try {
    const result = await runHarness({
      dshBin: script,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 1500,
      graceMs: 800, // 第 700ms 先 SIGTERM，第 1500ms 再 SIGKILL
    })
    assert.equal(result.outcome, 'timeout')
    assert.match(result.error ?? '', /SIGTERM/, 'error 应说明已先送 SIGTERM 收口')
    assert.match(result.error ?? '', /做到一半/, 'error 应带上截止时的进展（交接信息）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('graceMs=0 时退回旧行为：不打招呼直接强制终止', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilee-grace0-'))
  const script = join(dir, 'hang.mjs')
  writeFileSync(script, `setInterval(() => {}, 1000)`)
  try {
    const result = await runHarness({
      dshBin: script,
      nodePath: process.execPath,
      cwd: dir,
      prompt: 'x',
      timeoutMs: 800,
      graceMs: 0,
    })
    assert.equal(result.outcome, 'timeout')
    assert.match(result.error ?? '', /未设收口时间/, '应明确说明没有收口时间')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})