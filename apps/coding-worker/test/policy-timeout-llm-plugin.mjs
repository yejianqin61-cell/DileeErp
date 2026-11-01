import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const provider = 'dilee-policy-timeout'

class HangingAdapter extends LlmAdapter {
  resolveModel(selectedProvider, model) {
    return Promise.resolve({ provider: selectedProvider, id: model, name: model })
  }

  async * stream() {
    await new Promise(() => {})
  }
}

export const inject = ['llm']

export function apply(ctx) {
  const pidPath = process.env.DILEE_RUNTIME_PID_PATH
  if (!pidPath) throw new Error('DILEE_RUNTIME_PID_PATH is required')
  writeFileSync(pidPath, String(process.pid), { encoding: 'utf8', flag: 'wx' })
  ctx.llm.registerAdapter([provider], new HangingAdapter())
  ctx.provide('dileePolicyTimeoutLlm', {})
}

