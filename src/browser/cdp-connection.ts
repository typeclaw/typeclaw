// One CDP WebSocket to the shared browser: commands with a reply timeout, and
// events delivered to listeners registered before the command that triggers them.

const COMMAND_TIMEOUT_MS = 10_000

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type EventListener = { method: string; sessionId: string; onEvent: (params: unknown) => void }

export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<EventListener>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)))
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('browser connection closed'))
      }
      this.pending.clear()
    })
  }

  static open(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true })
      socket.addEventListener('error', () => reject(new Error('could not connect to the shared browser')), {
        once: true,
      })
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  // Registered before the triggering command so a fast event can't slip past.
  waitForEvent(
    method: string,
    sessionId: string,
    predicate: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const listener: EventListener = {
        method,
        sessionId,
        onEvent: (params) => {
          if (!predicate(params)) return
          finish(true)
        },
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        resolve(value)
      }
      this.listeners.add(listener)
    })
  }

  close(): void {
    this.socket.close()
  }

  private onMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: unknown
      sessionId?: string
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error !== undefined) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    for (const listener of this.listeners) {
      if (listener.method === message.method && listener.sessionId === message.sessionId)
        listener.onEvent(message.params)
    }
  }
}
