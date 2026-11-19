import { join } from 'node:path'

import { EMBEDDING_DIMS } from '@/models/embedding-model'

import { modelCachePath } from './embedder-cache-path'
import { EMBED_BATCH_SIZE, embedReply, type EmbedRequest, type EmbedType } from './embedder-wire'

export const EMBEDDER_IDLE_MS = 5 * 60_000
const QUERY_TIMEOUT_MS = 60_000
const PASSAGE_STALL_MS = 15 * 60_000
const CHILD_ENTRY = join(import.meta.dir, 'embedder-child.ts')

type Pending = {
  readonly count: number
  readonly stallMs: number | undefined
  timer: ReturnType<typeof setTimeout>
  completed: number
  readonly resolve: (vectors: Float32Array[]) => void
  readonly reject: (error: Error) => void
}

type ChildProcess = Pick<Bun.Subprocess<'ignore', 'inherit', 'inherit'>, 'exited' | 'kill' | 'send' | 'unref'>
type ChildEvents = { readonly message: (message: unknown) => void; readonly exit: (error: Error) => void }

type Child = {
  readonly process: ChildProcess
  readonly pending: Map<number, Pending>
  idle?: ReturnType<typeof setTimeout>
}

class EmbedderProcessError extends Error {}

export class EmbedderProcess {
  private child: Child | undefined
  private retiring: Promise<number> | undefined
  private disposed = false
  private nextId = 0

  constructor(
    private readonly options: {
      readonly entry?: string
      readonly idleMs?: number
      readonly queryTimeoutMs?: number
      readonly passageStallMs?: number
      readonly launch?: (events: ChildEvents) => ChildProcess
    } = {},
  ) {}

  async embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const stallMs = type === 'passage' ? (this.options.passageStallMs ?? PASSAGE_STALL_MS) : undefined
    const timeoutMs = stallMs ?? this.options.queryTimeoutMs ?? QUERY_TIMEOUT_MS
    const deadline = performance.now() + timeoutMs
    while (this.retiring !== undefined) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new EmbedderProcessError(`${type} embedding request timed out`)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.retiring,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new EmbedderProcessError(`${type} embedding request timed out`)), remaining)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (this.disposed) throw new EmbedderProcessError('embedding subprocess was stopped')
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new EmbedderProcessError(`${type} embedding request timed out`)
    const child = (this.child ??= this.spawn())
    clearTimeout(child.idle)
    const request: EmbedRequest = { id: ++this.nextId, type, texts }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.retire(child, new EmbedderProcessError(`${type} embedding request timed out`))
      }, remaining)
      child.pending.set(request.id, { count: texts.length, stallMs, completed: 0, timer, resolve, reject })
      try {
        child.process.send(request)
      } catch (error) {
        this.retire(child, new EmbedderProcessError('could not send embedding request', { cause: error }))
      }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.child !== undefined) this.retire(this.child, new EmbedderProcessError('embedding subprocess was stopped'))
    await this.retiring
  }

  private spawn(): Child {
    const child: Child = {
      pending: new Map(),
      process: (this.options.launch ?? ((events) => this.launch(events)))({
        message: (message) => this.receive(child, message),
        exit: (error) => this.retire(child, error),
      }),
    }
    child.process.unref()
    return child
  }

  private launch(events: ChildEvents): ChildProcess {
    const bun = [process.execPath, '--smol', '--no-env-file', this.options.entry ?? CHILD_ENTRY, String(process.pid)]
    // The Linux runtime image ships setpriv. Arm a kernel kill even if the
    // parent's IPC closes while native inference blocks the child's JS loop.
    const command = process.platform === 'linux' ? ['/usr/bin/setpriv', '--pdeathsig', 'KILL', ...bun] : bun
    return Bun.spawn(command, {
      cwd: import.meta.dir,
      env: { TYPECLAW_MODEL_CACHE: modelCachePath() },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      serialization: 'advanced',
      ipc: events.message,
      onExit: (_process, code, signal, error) =>
        events.exit(new EmbedderProcessError(`embedding subprocess exited (${signal ?? code})`, { cause: error })),
      onDisconnect: () => events.exit(new EmbedderProcessError('embedding subprocess disconnected')),
    })
  }

  private receive(child: Child, message: unknown): void {
    if (this.child !== child) return
    const reply = embedReply.safeParse(message)
    const pending = reply.success ? child.pending.get(reply.data.id) : undefined
    if (!reply.success || pending === undefined) {
      this.retire(child, new EmbedderProcessError('invalid embedding subprocess reply'))
      return
    }
    const { data } = reply
    if (data.kind === 'progress') {
      if (
        pending.stallMs === undefined ||
        pending.completed === pending.count ||
        data.completed !== Math.min(pending.completed + EMBED_BATCH_SIZE, pending.count)
      ) {
        this.retire(child, new EmbedderProcessError('invalid embedding subprocess batch progress'))
        return
      }
      pending.completed = data.completed
      clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        this.retire(child, new EmbedderProcessError('passage embedding request timed out'))
      }, pending.stallMs)
      return
    }
    if (
      data.kind === 'result' &&
      (data.vectors.length !== pending.count || data.vectors.some((vector) => vector.length !== EMBEDDING_DIMS))
    ) {
      this.retire(child, new EmbedderProcessError('invalid embedding subprocess vector dimensions'))
      return
    }
    child.pending.delete(data.id)
    clearTimeout(pending.timer)
    switch (data.kind) {
      case 'result':
        pending.resolve(data.vectors)
        break
      case 'error':
        pending.reject(new EmbedderProcessError(data.message))
        break
      default:
        data satisfies never
    }
    if (child.pending.size === 0) {
      child.idle = setTimeout(() => this.retire(child), this.options.idleMs ?? EMBEDDER_IDLE_MS).unref()
    }
  }

  private retire(child: Child, error?: Error): void {
    if (this.child !== child) return
    this.child = undefined
    clearTimeout(child.idle)
    const exited = child.process.exited
    this.retiring = exited
    void exited.then(() => {
      if (this.retiring === exited) this.retiring = undefined
    })
    child.process.kill('SIGKILL')
    for (const request of child.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error ?? new EmbedderProcessError('embedding subprocess stopped'))
    }
    child.pending.clear()
  }
}
