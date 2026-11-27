import { randomUUID } from 'node:crypto'

import { CellOutput, CODEMODE_LIMITS, CodemodeError, type HostFrame, type KernelFrame } from './protocol'
import { assertNever } from './wire'

export type CodemodeDispatch = (
  request: {
    readonly name: string
    readonly args: Extract<KernelFrame, { type: 'tool-call' }>['args']
    readonly callId: string
  },
  signal: AbortSignal,
) => Promise<unknown>

export class CodemodeCell {
  readonly id = randomUUID()
  readonly output = new CellOutput()
  readonly completed = Promise.withResolvers<void>()
  private readonly ids = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  // Calls past the concurrency cap wait for a slot instead of failing the cell:
  // `Promise.all` over many tool reads is ordinary cell code.
  private readonly waiting: Array<(granted: boolean) => void> = []
  private active = 0
  private finished = false

  constructor(
    private readonly dispatch: CodemodeDispatch,
    private readonly signal: AbortSignal,
  ) {
    // Queued calls must not outlive a cancelled cell just because an active
    // tool is slow to honor the abort.
    signal.addEventListener(
      'abort',
      () => {
        for (const wake of this.waiting.splice(0)) wake(false)
      },
      { once: true },
    )
  }

  receive(frame: KernelFrame, send: (frame: HostFrame) => void): void {
    switch (frame.type) {
      case 'ready':
        throw new CodemodeError('protocol', 'unexpected ready frame')
      case 'output':
        this.assertActive(frame.cellId)
        this.output.append(frame.text)
        return
      case 'done':
        this.assertActive(frame.cellId)
        this.finished = true
        void Promise.all(this.pending).then(() => {
          if (frame.error === undefined) this.completed.resolve()
          else this.completed.reject(new CodemodeError('cell', frame.error))
        }, this.completed.reject)
        return
      case 'tool-call': {
        this.assertActive(frame.cellId)
        if (this.ids.has(frame.id) || this.ids.size >= CODEMODE_LIMITS.calls) {
          throw new CodemodeError('protocol', 'codemode tool-call id or count limit exceeded')
        }
        this.ids.add(frame.id)
        const task = this.invoke(frame, send)
        this.pending.add(task)
        void task.then(() => this.pending.delete(task), this.completed.reject)
        return
      }
      default:
        assertNever(frame)
    }
  }

  private assertActive(cellId: string): void {
    if (this.finished || this.signal.aborted || cellId !== this.id) {
      throw new CodemodeError('protocol', 'codemode frame is outside its active cell')
    }
  }

  private async invoke(
    frame: Extract<KernelFrame, { type: 'tool-call' }>,
    send: (frame: HostFrame) => void,
  ): Promise<void> {
    if (!(await this.acquireSlot())) return
    try {
      if (this.signal.aborted) return
      const value = await this.dispatch(
        {
          name: frame.name,
          args: frame.args,
          callId: `codemode:${this.id}:${frame.id}`,
        },
        this.signal,
      )
      if (!this.signal.aborted) send({ type: 'tool-result', id: frame.id, value })
    } catch (error) {
      if (!this.signal.aborted)
        send({
          type: 'tool-error',
          id: frame.id,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
        })
    } finally {
      this.releaseSlot()
    }
  }

  private async acquireSlot(): Promise<boolean> {
    if (this.signal.aborted) return false
    if (this.active < CODEMODE_LIMITS.concurrency) {
      this.active += 1
      return true
    }
    const turn = Promise.withResolvers<boolean>()
    this.waiting.push(turn.resolve)
    return turn.promise
  }

  // A finishing call hands its slot straight to the next waiter, so `active`
  // never exceeds the cap.
  private releaseSlot(): void {
    const next = this.waiting.shift()
    if (next) next(true)
    else this.active -= 1
  }
}
