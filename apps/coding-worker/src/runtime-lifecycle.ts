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
  deadlineMs?: number
}

export interface CodingBatchResult {
  batchId: string
  parentSessionId: string
  run: RunResult
}

export class CodingBatchTimeoutError extends Error {
  readonly code = 'CODING_BATCH_TIMEOUT'
  readonly batchId: string
  readonly deadlineMs: number

  constructor(batchId: string, deadlineMs: number) {
    super(`coding batch ${batchId} exceeded its ${deadlineMs}ms deadline`)
    this.name = 'CodingBatchTimeoutError'
    this.batchId = batchId
    this.deadlineMs = deadlineMs
  }
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
  const noFailure = Symbol('no-failure')
  let operationFailure: unknown | typeof noFailure = noFailure
  try {
    await runtime.start()
    return await operation(runtime)
  } catch (error) {
    operationFailure = error
    throw error
  } finally {
    try {
      await runtime.close()
    } catch (cleanupFailure) {
      if (operationFailure !== noFailure) {
        throw new AggregateError(
          [operationFailure, cleanupFailure],
          'coding runtime operation and cleanup both failed',
        )
      }
      throw cleanupFailure
    }
  }
}

async function withinBatchDeadline<T>(
  request: CodingBatchRequest,
  operation: () => Promise<T>,
): Promise<T> {
  if (request.deadlineMs === undefined) return operation()
  if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
    throw new TypeError('deadlineMs must be a positive finite number')
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CodingBatchTimeoutError(request.batchId, request.deadlineMs!)),
      request.deadlineMs,
    )
  })
  try {
    return await Promise.race([operation(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function runCodingBatch(
  request: CodingBatchRequest,
  factory: CodingRuntimeFactory = createRuntime,
): Promise<CodingBatchResult> {
  const run = await runWithCodingRuntime(
    request,
    runtime => withinBatchDeadline(request, async () => {
      const result = await runtime.run(request.prompt, { sessionId: request.parentSessionId })
      await runtime.client.request('session/wait', { sessionId: request.parentSessionId })
      return result
    }),
    factory,
  )
  return {
    batchId: request.batchId,
    parentSessionId: request.parentSessionId,
    run,
  }
}
