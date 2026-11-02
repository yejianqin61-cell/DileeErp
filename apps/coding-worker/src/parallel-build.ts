import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runCodingBatch,
  type CodingBatchResult,
  type CodingRuntimeConfig,
  type CodingRuntimeFactory,
} from './runtime-lifecycle.ts'
import { readActivationTrace } from './activation-trace.ts'
import { normalizeBatchProgressEvents, type BatchProgressEvent } from './batch-progress-events.ts'

export interface ParallelCapabilityRequest {
  readonly capabilityId: string
  readonly attemptId: string
  readonly workspace: string
  readonly prompt: string
  readonly round?: number
}

export interface ParallelCodingBuildResult extends CodingBatchResult {
  readonly capabilityId: string
  readonly attemptId: string
  readonly round: number
  readonly progressEvents: BatchProgressEvent[]
}

export type ParallelCodingBuildConfig = Omit<CodingRuntimeConfig, 'workspace'>

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const activationTracePatch = resolve(packageRoot, 'config', 'activation-trace.cordis.patch.yml')

function assertPathSegment(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) || value === '.' || value === '..') {
    throw new TypeError(`${name} must be a safe path segment`)
  }
}

export async function runParallelCodingBuilds(
  config: ParallelCodingBuildConfig,
  capabilities: readonly ParallelCapabilityRequest[],
  factory?: CodingRuntimeFactory,
  signal?: AbortSignal,
): Promise<ParallelCodingBuildResult[]> {
  if (capabilities.length === 0) throw new TypeError('at least one capability is required')
  const ids = new Set<string>()
  const workspaces = new Set<string>()
  for (const capability of capabilities) {
    assertPathSegment(capability.capabilityId, 'capabilityId')
    assertPathSegment(capability.attemptId, 'attemptId')
    if (!capability.capabilityId || ids.has(capability.capabilityId)) {
      throw new TypeError(`duplicate capabilityId: ${capability.capabilityId}`)
    }
    ids.add(capability.capabilityId)
    const resolvedWorkspace = resolve(capability.workspace)
    const workspace = process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace
    if (workspaces.has(workspace)) throw new TypeError('each capability must use a unique workspace')
    workspaces.add(workspace)
    if (!capability.attemptId || !capability.prompt) {
      throw new TypeError('attemptId and prompt are required for every capability')
    }
    if (capability.round !== undefined
      && (!Number.isSafeInteger(capability.round) || capability.round < 1)) {
      throw new TypeError('round must be a positive safe integer')
    }
  }

  if (signal?.aborted) throw signal.reason
  const controller = new AbortController()
  let primaryFailure: unknown
  const abortFromCaller = (): void => {
    primaryFailure = signal?.reason ?? new Error('parallel coding batch cancelled')
    controller.abort(primaryFailure)
  }
  signal?.addEventListener('abort', abortFromCaller, { once: true })
  const settled = await Promise.allSettled(capabilities.map(async (capability) => {
    try {
      const dshHome = join(resolve(config.dshHome), capability.capabilityId, capability.attemptId)
      await mkdir(dshHome, { recursive: true })
      const batch = await runCodingBatch({
        ...config,
        workspace: capability.workspace,
        dshHome,
        patches: config.patches.some(patch => resolve(patch) === activationTracePatch)
          ? config.patches
          : [...config.patches, activationTracePatch],
        environment: {
          ...config.environment,
          DILEE_ACTIVATION_LOG_PATH: join(dshHome, 'activations.jsonl'),
        },
        batchId: `${capability.capabilityId}:${capability.attemptId}`,
        parentSessionId: `${capability.capabilityId}:${capability.attemptId}:parent`,
        prompt: capability.prompt,
        signal: controller.signal,
      }, factory)
      const tracePath = join(dshHome, 'activations.jsonl')
      const activations = await readActivationTrace(tracePath)
      const round = capability.round ?? 1
      return {
        ...batch,
        capabilityId: capability.capabilityId,
        attemptId: capability.attemptId,
        round,
        progressEvents: normalizeBatchProgressEvents({
          batchId: batch.batchId,
          capabilityId: capability.capabilityId,
          attemptId: capability.attemptId,
          round,
        }, {
          sdkEvents: batch.run.events,
          notifications: batch.run.notifications,
          activations,
        }),
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        primaryFailure = error
        controller.abort(error)
      }
      throw error
    }
  }))
  signal?.removeEventListener('abort', abortFromCaller)
  const failures = settled.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
  const independentFailures = failures.filter(error =>
    !(error instanceof Error && error.name === 'CodingBatchCancelledError' && error.cause === primaryFailure))
  if (primaryFailure !== undefined && independentFailures.length === 0) throw primaryFailure
  if (primaryFailure !== undefined && independentFailures.length === 1 && independentFailures[0] === primaryFailure) {
    throw primaryFailure
  }
  if (independentFailures.length === 1) throw independentFailures[0]
  if (independentFailures.length > 1) throw new AggregateError(independentFailures, 'multiple capability builds failed')
  return settled.map(item => (item as PromiseFulfilledResult<ParallelCodingBuildResult>).value)
}
