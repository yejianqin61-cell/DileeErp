import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client'

import { assertInstalledRuntimeContract } from './runtime-contract.ts'

export interface CodingRuntimeClient {
  request(method: string, params?: object): Promise<unknown>
}

export type CodingRuntime = Pick<DeepSeekHarness, 'start' | 'run' | 'close'> & {
  readonly client: CodingRuntimeClient
}
export type CodingRuntimeFactory = (options: DeepSeekHarnessOptions) => CodingRuntime

export interface CodingRuntimeConfig {
  workspace: string
  dshHome: string
  patches: string[]
  environment: NodeJS.ProcessEnv
  initializeTimeoutMs?: number
  provider?: string
  model?: string
}

export interface CodingBatchRequest extends CodingRuntimeConfig {
  batchId: string
  parentSessionId: string
  prompt: string
}

export interface CodingBatchResult {
  batchId: string
  parentSessionId: string
  run: RunResult
}

const createRuntime: CodingRuntimeFactory = options => new DeepSeekHarness(options)

function runtimeOptions(config: CodingRuntimeConfig): DeepSeekHarnessOptions {
  return {
    profile: 'sdk',
    cwd: config.workspace,
    processCwd: config.workspace,
    dshHome: config.dshHome,
    patches: config.patches,
    env: config.environment,
    ...config.initializeTimeoutMs === undefined
      ? {}
      : { initializeTimeoutMs: config.initializeTimeoutMs },
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
}

export async function runWithCodingRuntime<T>(
  config: CodingRuntimeConfig,
  operation: (runtime: CodingRuntime) => Promise<T>,
  factory: CodingRuntimeFactory = createRuntime,
): Promise<T> {
  assertInstalledRuntimeContract()
  const runtime = factory(runtimeOptions(config))
  try {
    await runtime.start()
    return await operation(runtime)
  } finally {
    await runtime.close()
  }
}

export async function runCodingBatch(
  request: CodingBatchRequest,
  factory: CodingRuntimeFactory = createRuntime,
): Promise<CodingBatchResult> {
  const run = await runWithCodingRuntime(
    request,
    async (runtime) => {
      const result = await runtime.run(request.prompt, { sessionId: request.parentSessionId })
      await runtime.client.request('session/wait', { sessionId: request.parentSessionId })
      return result
    },
    factory,
  )
  return {
    batchId: request.batchId,
    parentSessionId: request.parentSessionId,
    run,
  }
}
