import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client'

import { assertInstalledRuntimeContract } from './runtime-contract.ts'

export type CodingRuntime = Pick<DeepSeekHarness, 'start' | 'run' | 'close'>
export type CodingRuntimeFactory = (options: DeepSeekHarnessOptions) => CodingRuntime

export interface CodingRuntimeConfig {
  workspace: string
  dshHome: string
  patches: string[]
  environment: NodeJS.ProcessEnv
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
    runtime => runtime.run(request.prompt, { sessionId: request.parentSessionId }),
    factory,
  )
  return {
    batchId: request.batchId,
    parentSessionId: request.parentSessionId,
    run,
  }
}
