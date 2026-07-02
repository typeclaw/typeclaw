import { type BenchServerMessage, type BenchToolCall, type BenchUsage, isServerMessage } from './protocol'

export type TurnResult = {
  text: string
  toolCalls: BenchToolCall[]
  usage: BenchUsage | null
  error: string | null
}

export type RunTaskOptions = {
  url: string
  prompt: string
  connectTimeoutMs?: number
  turnTimeoutMs?: number
}

export async function runTask(options: RunTaskOptions): Promise<TurnResult> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000
  const turnTimeoutMs = options.turnTimeoutMs ?? 600_000

  const ws = new WebSocket(options.url)
  const inbox = createInbox(ws)

  try {
    await inbox.waitFor((m) => m.type === 'connected', connectTimeoutMs, 'connected handshake')
    ws.send(JSON.stringify({ type: 'prompt', text: options.prompt }))
    return await collectTurn(inbox, turnTimeoutMs)
  } finally {
    ws.close()
  }
}

// Collect the first turn's output. The agent's todo-continuation can enqueue a
// follow-up turn after the user turn's `done`, so we stop at the FIRST `done` —
// the user-facing result is already complete by then. `error` also terminates.
async function collectTurn(inbox: Inbox, timeoutMs: number): Promise<TurnResult> {
  const textChunks: string[] = []
  const toolCalls = new Map<string, BenchToolCall>()

  while (true) {
    const message = await inbox.next(timeoutMs)

    switch (message.type) {
      case 'text_delta':
        textChunks.push(String((message as { delta?: unknown }).delta ?? ''))
        break
      case 'tool_start': {
        const m = message as Extract<BenchServerMessage, { type: 'tool_start' }>
        toolCalls.set(m.toolCallId, { toolCallId: m.toolCallId, name: m.name, args: m.args })
        break
      }
      case 'tool_end': {
        const m = message as Extract<BenchServerMessage, { type: 'tool_end' }>
        const existing = toolCalls.get(m.toolCallId)
        toolCalls.set(m.toolCallId, {
          toolCallId: m.toolCallId,
          name: m.name,
          args: existing?.args,
          result: m.result,
          isError: m.error,
          durationMs: m.durationMs,
        })
        break
      }
      case 'done': {
        const usage = (message as Extract<BenchServerMessage, { type: 'done' }>).usage ?? null
        return { text: textChunks.join(''), toolCalls: [...toolCalls.values()], usage, error: null }
      }
      case 'error': {
        const errorMessage = String((message as { message?: unknown }).message ?? 'unknown error')
        return { text: textChunks.join(''), toolCalls: [...toolCalls.values()], usage: null, error: errorMessage }
      }
      default:
        break
    }
  }
}

type Inbox = {
  waitFor: (
    predicate: (m: BenchServerMessage) => boolean,
    timeoutMs: number,
    label: string,
  ) => Promise<BenchServerMessage>
  next: (timeoutMs: number) => Promise<BenchServerMessage>
}

function createInbox(ws: WebSocket): Inbox {
  const buffer: BenchServerMessage[] = []
  const waiters: { resolve: (m: BenchServerMessage) => void }[] = []

  ws.addEventListener('message', (event) => {
    const parsed: unknown = JSON.parse(String((event as MessageEvent).data))
    if (!isServerMessage(parsed)) return
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(parsed)
    else buffer.push(parsed)
  })

  const take = (timeoutMs: number, label: string): Promise<BenchServerMessage> => {
    const buffered = buffer.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs,
      )
      waiters.push({
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  return {
    next: (timeoutMs) => take(timeoutMs, 'server message'),
    waitFor: async (predicate, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
        const message = await take(remaining, label)
        if (predicate(message)) return message
      }
    },
  }
}
