import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readActivationTrace, type ActivationTraceRecord } from './activation-trace.ts'
import { startModelRelay, readModelRelayConfig } from './model-relay.ts'
import { runSingleParentBatch, type SingleParentCapability } from './single-parent-batch.ts'
import type { CodingBatchResult } from './runtime-lifecycle.ts'

function rootEnv(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/u)
    .filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
}

export async function runRealModelDual(input: {
  workspace: string
  workerRoot: string
  dshHome: string
  tracePath: string
  parentSessionId: string
  envFile: string
  capabilities: readonly SingleParentCapability[]
  deadlineMs?: number
}): Promise<{ readonly batch: CodingBatchResult; readonly trace: ActivationTraceRecord[] }> {
  const relayToken = randomUUID()
  const relay = await startModelRelay(readModelRelayConfig({
    ...rootEnv(input.envFile), DILEE_MODEL_RELAY_TOKEN: relayToken,
  }))
  try {
    const batch = await runSingleParentBatch({
      workspace: input.workspace,
      dshHome: input.dshHome,
      patches: [
        join(input.workerRoot, 'config', 'coding-agents.cordis.patch.yml'),
        join(input.workerRoot, 'config', 'real-model-pi-ai-relay.cordis.patch.yml'),
        join(input.workerRoot, 'config', 'activation-trace.cordis.patch.yml'),
      ],
      environment: {
        ...process.env,
        DILEE_PARENT_SESSION_ID: input.parentSessionId,
        DILEE_MODEL_RELAY_URL: relay.url,
        DILEE_MODEL_RELAY_TOKEN: relayToken,
        DILEE_ACTIVATION_LOG_PATH: input.tracePath,
        DILEE_CANDIDATE_WORKSPACE: input.workspace,
        DILEE_VERIFY_CANDIDATE_HASHES: 'true',
        DSH_TELEMETRY_MODE: 'OFF',
      },
      initializeTimeoutMs: 30_000,
      provider: 'phase1-deepseek',
      model: 'deepseek-chat',
    }, {
      batchId: `real-model-dual-${randomUUID()}`,
      parentSessionId: input.parentSessionId,
      capabilities: input.capabilities,
      deadlineMs: input.deadlineMs ?? 20 * 60_000,
    })
    return { batch, trace: await readActivationTrace(input.tracePath) }
  } finally {
    await relay.close()
  }
}
