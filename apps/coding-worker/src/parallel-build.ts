import { resolve } from 'node:path'

import {
  runCodingBatch,
  type CodingBatchResult,
  type CodingRuntimeConfig,
  type CodingRuntimeFactory,
} from './runtime-lifecycle.ts'

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
}

export type ParallelCodingBuildConfig = Omit<CodingRuntimeConfig, 'workspace'>

export async function runParallelCodingBuilds(
  config: ParallelCodingBuildConfig,
  capabilities: readonly ParallelCapabilityRequest[],
  factory?: CodingRuntimeFactory,
): Promise<ParallelCodingBuildResult[]> {
  if (capabilities.length === 0) throw new TypeError('at least one capability is required')
  const ids = new Set<string>()
  const workspaces = new Set<string>()
  for (const capability of capabilities) {
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

  const settled = await Promise.allSettled(capabilities.map(async (capability) => {
    const batch = await runCodingBatch({
      ...config,
      workspace: capability.workspace,
      batchId: `${capability.capabilityId}:${capability.attemptId}`,
      parentSessionId: `${capability.capabilityId}:${capability.attemptId}:parent`,
      prompt: capability.prompt,
    }, factory)
    return {
      ...batch,
      capabilityId: capability.capabilityId,
      attemptId: capability.attemptId,
      round: capability.round ?? 1,
    }
  }))
  const failures = settled.flatMap(item => item.status === 'rejected' ? [item.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'multiple capability builds failed')
  return settled.map(item => (item as PromiseFulfilledResult<ParallelCodingBuildResult>).value)
}
