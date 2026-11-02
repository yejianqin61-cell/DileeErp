import type { HarnessNotification, RunResult } from '@deepseek-ai/dsh-sdk-client'

import type { ActivationTraceRecord } from './activation-trace.ts'

export interface BatchProgressContext {
  readonly batchId: string
  readonly capabilityId: string
  readonly attemptId: string
  readonly round: number
}

export type BatchProgressSource = 'sdk-event' | 'sdk-notification' | 'activation'

export interface BatchProgressEvent extends BatchProgressContext {
  readonly seq: number
  readonly source: BatchProgressSource
  readonly payload: unknown
}

export interface BatchProgressInput {
  readonly sdkEvents: RunResult['events']
  readonly notifications: HarnessNotification[]
  readonly activations: ActivationTraceRecord[]
}

function assertContext(context: BatchProgressContext): void {
  if (!context.batchId || !context.capabilityId || !context.attemptId) {
    throw new TypeError('batchId, capabilityId, and attemptId are required')
  }
  if (!Number.isSafeInteger(context.round) || context.round < 1) {
    throw new TypeError('round must be a positive safe integer')
  }
}

function assertActivation(record: ActivationTraceRecord, index: number): void {
  if (record.seq !== index + 1
    || (record.event !== 'start' && record.event !== 'end')
    || !record.runId
    || !record.childSessionId
    || !record.provider
    || typeof record.local !== 'boolean'
    || (record.event === 'end' && !record.stopReason)) {
    throw new TypeError(`invalid Activation record at index ${index}`)
  }
}

export function normalizeBatchProgressEvents(
  context: BatchProgressContext,
  input: BatchProgressInput,
): BatchProgressEvent[] {
  assertContext(context)
  input.activations.forEach(assertActivation)
  let seq = 0
  const normalize = (source: BatchProgressSource, payload: unknown): BatchProgressEvent => ({
    ...context,
    seq: ++seq,
    source,
    payload,
  })
  return [
    ...input.sdkEvents.map(event => normalize('sdk-event', event)),
    ...input.notifications.map(notification => normalize('sdk-notification', notification)),
    ...input.activations.map(activation => normalize('activation', activation)),
  ]
}
