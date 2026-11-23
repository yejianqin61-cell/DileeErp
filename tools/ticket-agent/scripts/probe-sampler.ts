/**
 * 真机探针：验证 RunSampler 在 Linux 上真的能读到进程树 CPU。
 *
 * 为什么必须单独验一次：RunSampler 在没有 /proc 的平台（开发机 Windows）恒定返回 0，
 * 而编排层把「processCount=0」当成「这一轮没观测到」直接跳过判定。
 * 所以「采样器在服务器上读得到」不是锦上添花，而是看门狗能不能工作的前提 ——
 * 读不到的话它永远不会报，等于没上线，而且安静得让人以为一切正常。
 *
 * 判据：
 *   1. 忙的子进程（吃满一个核）→ totalPercent 明显 > 10%，busiestChildPercent > 10%
 *   2. 闲的子进程（sleep）→ totalPercent 接近 0
 * 两组必须能区分开，否则判据（cpuFloorPercent = 1）就没有意义。
 */

import { spawn } from 'node:child_process'

import { RunSampler } from '../src/run-sampler.ts'

const RUN_ID = `probe-${Date.now()}`

function spawnTagged(args: string[], env: Record<string, string>): { pid: number | undefined; kill: () => void } {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, DILEE_RUN_ID: RUN_ID, ...env },
    stdio: 'ignore',
    detached: true,
  })
  return {
    pid: child.pid,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 已退出
        }
      }
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function measure(
  label: string,
  command: string,
  args: string[],
  windowMs = 2500,
): Promise<void> {
  const child = spawnTagged([], {})
  child.kill()
  // 用 bash 再套一层，造出「父 → 子」结构：真实 run 是 dsh(node) → bash → tsc，
  // 判据第三条（子进程 CPU > 5% 就算还在干活）认的正是这一层。
  const outer = spawn(command, args, {
    env: { ...process.env, DILEE_RUN_ID: RUN_ID },
    stdio: 'ignore',
    detached: true,
  })
  if (outer.pid === undefined) throw new Error('spawn 失败：拿不到 pid')
  const sampler = new RunSampler({ runId: RUN_ID, mainPid: outer.pid })
  try {
    // 三帧：第一帧建基线；本窗口才出现的子进程没有基线，按设计不给百分比。
    // 所以「子进程算不算在干活」要看第二、三帧 —— 真实场景里 60 秒一个点，够用。
    const line: string[] = []
    for (let frame = 0; frame < 3; frame += 1) {
      const snap = sampler.sample()
      line.push(`[${frame}] total=${snap.totalPercent.toFixed(1)}% child=${snap.busiestChildPercent.toFixed(1)}% n=${snap.processCount}`)
      await sleep(windowMs)
    }
    console.log(`${label}: ${line.join('  ')}`)
  } finally {
    try {
      if (outer.pid !== undefined) process.kill(-outer.pid, 'SIGKILL')
    } catch {
      try {
        outer.kill('SIGKILL')
      } catch {
        // 已退出
      }
    }
  }
}

const busy = `
  const end = Date.now() + 12000
  while (Date.now() < end) { Math.sqrt(Math.random()) }
`
const idle = `setTimeout(() => {}, 12000)`

console.log(`run id: ${RUN_ID}`)
// 场景 1：父进程自己忙（无子进程）
await measure('父自己忙', process.execPath, ['-e', busy])
await sleep(300)
// 场景 2：父进程闲、**子进程忙** —— 这正是「在编译 / 在跑测试」的样子，
// 看门狗必须判 alive，绝不能判死锁。
//
// 注意必须 `& wait`：`bash -c '单条命令'` 会被 bash 直接 exec 掉，
// 父子合成一个进程，那样测的其实还是场景 1（第一版探针就栽在这里）。
await measure('父闲子忙', '/bin/bash', ['-c', `${process.execPath} -e '${busy.replace(/'/g, "'\\''")}' & wait`])
await sleep(300)
// 场景 3：父子都闲 —— 这才是「疑似死锁」该长成的样子
await measure('父子都闲', '/bin/bash', ['-c', `${process.execPath} -e '${idle}'`])
