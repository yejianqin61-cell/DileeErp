import { CODING_CONTAINER_IMAGE } from './container-policy.ts'
import type { Phase1DataBaseline } from './phase1-data-baseline.ts'
import type { RuntimeContract } from './runtime-contract.ts'

export interface Phase1PreflightInput {
  dockerEngine: string
  baseline?: Phase1DataBaseline
  modelRelayNetwork?: string
  modelRelayTokenPresent: boolean
  revision: string
  runtime: RuntimeContract
}

export interface Phase1PreflightResult {
  revision: string
  image: string
  baselineFingerprint: string
  modelRelayNetwork: string
  runtime: RuntimeContract
}

export function runPhase1Preflight(input: Phase1PreflightInput): Phase1PreflightResult {
  if (input.dockerEngine !== 'linux') throw new Error('LINUX_DOCKER_ENGINE_REQUIRED')
  if (input.baseline === undefined) throw new Error('PHASE1_BASELINE_REQUIRED')
  if (input.modelRelayNetwork === undefined || !input.modelRelayTokenPresent) {
    throw new Error('MODEL_RELAY_CONFIGURATION_REQUIRED')
  }
  if (!/^[a-f0-9]{7,64}$/.test(input.revision)) throw new Error('PHASE1_REVISION_INVALID')
  return {
    revision: input.revision,
    image: CODING_CONTAINER_IMAGE,
    baselineFingerprint: input.baseline.fingerprint,
    modelRelayNetwork: input.modelRelayNetwork,
    runtime: input.runtime,
  }
}
