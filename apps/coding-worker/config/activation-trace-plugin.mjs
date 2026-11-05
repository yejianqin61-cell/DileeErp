import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function apply(ctx) {
  const tracePath = process.env.DILEE_ACTIVATION_LOG_PATH
  if (!tracePath) throw new Error('DILEE_ACTIVATION_LOG_PATH is required')

  mkdirSync(dirname(tracePath), { recursive: true })
  writeFileSync(tracePath, '', { encoding: 'utf8', flag: 'wx' })
  let seq = 0

  const append = (event, info) => {
    const record = {
      seq: ++seq,
      event,
      runId: String(info.runId),
      childSessionId: String(info.id),
      provider: info.provider,
      local: info.local,
      at: performance.now(),
      ...(event === 'end' ? { stopReason: info.stopReason } : {}),
    }
    appendFileSync(tracePath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  ctx.on('subagent/start', info => append('start', info))
  ctx.on('subagent/end', info => append('end', info))
  ctx.on('dilee/activation-meta', info => appendFileSync(tracePath, `${JSON.stringify({
    seq: ++seq,
    event: 'meta',
    runId: String(info.runId),
    capabilityId: String(info.capabilityId),
    role: String(info.role),
  })}\n`, 'utf8'))
  ctx.on('dilee/candidate-submitted', submission => appendFileSync(tracePath, `${JSON.stringify({
    seq: ++seq,
    event: 'submission',
    capabilities: submission.capabilities,
  })}\n`, 'utf8'))
  ctx.on('dilee/validation-recorded', validation => appendFileSync(tracePath, `${JSON.stringify({
    seq: ++seq,
    event: 'validation',
    capabilityId: String(validation.capabilityId),
    codeHash: String(validation.codeHash),
    decision: String(validation.decision),
    report: String(validation.report),
  })}\n`, 'utf8'))
  ctx.provide('dileeActivationTrace', {})
}

