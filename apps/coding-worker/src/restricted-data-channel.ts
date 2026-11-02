import {
  RestrictedDataError,
  RestrictedDataGateway,
  type RestrictedDataContext,
} from './restricted-data-gateway.ts'

export async function handleRestrictedDataLine(
  line: string,
  gateway: RestrictedDataGateway,
  context: RestrictedDataContext,
): Promise<string> {
  if (line.length > 256 * 1024) return JSON.stringify({ ok: false, code: 'DATA_MESSAGE_TOO_LARGE' })
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch {
    return JSON.stringify({ ok: false, code: 'DATA_MESSAGE_INVALID' })
  }
  try {
    return JSON.stringify({ ok: true, result: await gateway.read(request, context) })
  } catch (error) {
    if (error instanceof RestrictedDataError) return JSON.stringify({ ok: false, code: error.code })
    throw error
  }
}
