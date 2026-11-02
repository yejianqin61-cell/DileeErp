import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readModelRelayConfig, startModelRelay } from './model-relay.ts'
import { runCodingBatch, type CodingBatchResult } from './runtime-lifecycle.ts'

function rootEnv(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/u)
    .filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
}

export async function runRealModelRework(input: {
  workspace: string
  workerRoot: string
  dshHome: string
  parentSessionId: string
  envFile: string
  deadlineMs?: number
}): Promise<CodingBatchResult> {
  const relayToken = randomUUID()
  const relay = await startModelRelay(readModelRelayConfig({
    ...rootEnv(input.envFile), DILEE_MODEL_RELAY_TOKEN: relayToken,
  }))
  try {
    return await runCodingBatch({
      batchId: `real-model-${randomUUID()}`,
      parentSessionId: input.parentSessionId,
      prompt: 'In the empty candidate workspace, create tool.ts and tool.test.ts for a pure employee-output formatter. Do not read network, secrets, or business data. Report only files and test result.',
      workspace: input.workspace,
      dshHome: input.dshHome,
      patches: [
        join(input.workerRoot, 'config', 'coding-agents.cordis.patch.yml'),
        join(input.workerRoot, 'config', 'real-model-pi-ai-relay.cordis.patch.yml'),
      ],
      environment: {
        ...process.env,
        DILEE_PARENT_SESSION_ID: input.parentSessionId,
        DILEE_MODEL_RELAY_URL: relay.url,
        DILEE_MODEL_RELAY_TOKEN: relayToken,
        DSH_TELEMETRY_MODE: 'OFF',
      },
      initializeTimeoutMs: 30_000,
      provider: 'phase1-deepseek',
      model: 'deepseek-flash',
      deadlineMs: input.deadlineMs ?? 20 * 60_000,
    })
  } finally {
    await relay.close()
  }
}
