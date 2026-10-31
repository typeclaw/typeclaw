import { randomUUID } from 'node:crypto'

import { CellOutput, EVAL_LIMITS, EvalError, type HostFrame, type KernelFrame } from './protocol'
import { assertNever } from './wire'

export type EvalDispatch = (
  request: {
    readonly name: string
    readonly args: Extract<KernelFrame, { type: 'tool-call' }>['args']
    readonly callId: string
  },
  signal: AbortSignal,
) => Promise<unknown>

export class EvalCell {
  readonly id = randomUUID()
  readonly output = new CellOutput()
  readonly completed = Promise.withResolvers<void>()
  private readonly ids = new Set<string>()
  private readonly pending = new Set<Promise<void>>()
  private finished = false

  constructor(
    private readonly dispatch: EvalDispatch,
    private readonly signal: AbortSignal,
  ) {}

  receive(frame: KernelFrame, send: (frame: HostFrame) => void): void {
    switch (frame.type) {
      case 'ready':
        throw new EvalError('protocol', 'unexpected ready frame')
      case 'output':
        this.assertActive(frame.cellId)
        this.output.append(frame.text)
        return
      case 'done':
        this.assertActive(frame.cellId)
        this.finished = true
        void Promise.all(this.pending).then(() => {
          if (frame.error === undefined) this.completed.resolve()
          else this.completed.reject(new EvalError('cell', frame.error))
        }, this.completed.reject)
        return
      case 'tool-call': {
        this.assertActive(frame.cellId)
        if (
          this.ids.has(frame.id) ||
          this.ids.size >= EVAL_LIMITS.calls ||
          this.pending.size >= EVAL_LIMITS.concurrency
        ) {
          throw new EvalError('protocol', 'eval tool-call id, count, or concurrency limit exceeded')
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
      throw new EvalError('protocol', 'eval frame is outside its active cell')
    }
  }

  private async invoke(
    frame: Extract<KernelFrame, { type: 'tool-call' }>,
    send: (frame: HostFrame) => void,
  ): Promise<void> {
    try {
      const value = await this.dispatch(
        {
          name: frame.name,
          args: frame.args,
          callId: `eval:${this.id}:${frame.id}`,
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
    }
  }
}
