import { resolveHostPort } from '@/container'
import type { ClientMessage, DoctorCheckPayload, DoctorFixPayload, ServerMessage } from '@/shared'

export type PluginBridgeOptions = {
  cwd: string
  url?: string
  timeoutMs?: number
}

export type PluginBridgeFetchChecks = (opts: PluginBridgeOptions) => Promise<PluginBridgeChecksResult>
export type PluginBridgeFetchFix = (opts: PluginBridgeOptions & { checkId: string }) => Promise<PluginBridgeFixResult>

export type PluginBridgeChecksResult =
  | { kind: 'ok'; checks: DoctorCheckPayload[] }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }

export type PluginBridgeFixResult =
  | { kind: 'ok'; payload: DoctorFixPayload }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }

const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchPluginDoctorChecks(opts: PluginBridgeOptions): Promise<PluginBridgeChecksResult> {
  const reach = await dial(opts)
  if (reach.kind !== 'ok') return reach
  const { ws, timeoutMs } = reach
  const requestId = randomId()
  try {
    return await withRequest<PluginBridgeChecksResult>(
      ws,
      timeoutMs,
      requestId,
      (msg) => {
        if (msg.type === 'doctor_result' && msg.requestId === requestId) {
          if (msg.error !== undefined) return { kind: 'error', reason: msg.error }
          return { kind: 'ok', checks: msg.checks }
        }
        return null
      },
      { type: 'doctor', requestId },
    )
  } finally {
    ws.close()
  }
}

export async function fetchPluginDoctorFix(
  opts: PluginBridgeOptions & { checkId: string },
): Promise<PluginBridgeFixResult> {
  const reach = await dial(opts)
  if (reach.kind !== 'ok') return reach
  const { ws, timeoutMs } = reach
  const requestId = randomId()
  try {
    return await withRequest<PluginBridgeFixResult>(
      ws,
      timeoutMs,
      requestId,
      (msg) => {
        if (msg.type === 'doctor_fix_result' && msg.requestId === requestId) {
          return { kind: 'ok', payload: msg.result }
        }
        return null
      },
      { type: 'doctor_fix', requestId, checkId: opts.checkId },
    )
  } finally {
    ws.close()
  }
}

type DialResult = { kind: 'ok'; ws: WebSocket; timeoutMs: number } | { kind: 'unreachable'; reason: string }

async function dial(opts: PluginBridgeOptions): Promise<DialResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let baseUrl = opts.url
  if (baseUrl === undefined) {
    try {
      const port = await resolveHostPort({ cwd: opts.cwd })
      baseUrl = `ws://localhost:${port}`
    } catch (err) {
      return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
    }
  }
  const url = `${baseUrl.replace(/\/$/, '')}/doctor`
  const ws = new WebSocket(url)
  let dialTimer: ReturnType<typeof setTimeout> | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        if (dialTimer !== null) clearTimeout(dialTimer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err: unknown) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(`failed to connect to ${url}`))
      }
      dialTimer = setTimeout(() => {
        cleanup()
        try {
          ws.close()
        } catch {}
        reject(new Error(`dial timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })
    })
  } catch (err) {
    return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
  }
  return { kind: 'ok', ws, timeoutMs }
}

async function withRequest<R extends { kind: string }>(
  ws: WebSocket,
  timeoutMs: number,
  _requestId: string,
  match: (msg: ServerMessage) => R | null,
  outgoing: ClientMessage,
): Promise<R | { kind: 'timeout' } | { kind: 'error'; reason: string }> {
  ws.send(JSON.stringify(outgoing))
  return new Promise((resolve) => {
    const settle = (value: R | { kind: 'timeout' } | { kind: 'error'; reason: string }): void => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
      resolve(value)
    }
    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
    const onMessage = (event: MessageEvent): void => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch (err) {
        settle({ kind: 'error', reason: err instanceof Error ? err.message : String(err) })
        return
      }
      const result = match(msg)
      if (result !== null) settle(result)
    }
    const onClose = (): void => settle({ kind: 'error', reason: 'doctor websocket closed before response' })
    const onError = (err: unknown): void =>
      settle({ kind: 'error', reason: err instanceof Error ? err.message : String(err) })
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose, { once: true })
    ws.addEventListener('error', onError, { once: true })
  })
}

function randomId(): string {
  return `doc-${crypto.randomUUID()}`
}
