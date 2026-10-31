import { EvalCell, type EvalDispatch } from './cell'
import { KernelProcess, type KernelLaunch } from './process'
import { EVAL_LIMITS, EvalError } from './protocol'

export type EvalResult = {
  readonly text: string
  readonly isError: boolean
  readonly truncated: boolean
  readonly restarted: boolean
}

// Owns one serial, foreground-only process. Preparing again before each cell
// rechecks bash's live masks and environment; changed authority loses bindings
// rather than reusing a kernel with an earlier principal's capabilities.
export class EvalKernel {
  private worker: { process: KernelProcess; launch: KernelLaunch } | undefined
  private active: EvalCell | undefined
  private controller: AbortController | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private used = false
  private stopping: Promise<void> = Promise.resolve()
  private disposal: Promise<void> | undefined

  constructor(
    private readonly prepare: () => Promise<KernelLaunch>,
    private readonly idleMs: number = EVAL_LIMITS.idleMs,
  ) {}

  async run(
    code: string,
    options: {
      readonly dispatch: EvalDispatch
      readonly signal?: AbortSignal
      readonly timeoutMs?: number
    },
  ): Promise<EvalResult> {
    if (this.closed) throw new EvalError('closed', 'eval session has ended')
    if (this.controller !== undefined) throw new EvalError('busy', 'another eval cell is running')
    if (Buffer.byteLength(code) > EVAL_LIMITS.codeBytes) throw new EvalError('refused', 'eval code exceeds 64 KiB')
    clearTimeout(this.idle)
    const controller = new AbortController()
    this.controller = controller
    const signal =
      options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
    const cell = new EvalCell(options.dispatch, signal)
    this.active = cell
    // Attach rejection handling before any startup event can fail the cell.
    const failure = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    const timeout = setTimeout(
      () => controller.abort(new EvalError('timeout', 'eval cell timed out; kernel killed and bindings lost')),
      Math.min(Math.max(options.timeoutMs ?? EVAL_LIMITS.timeoutMs, 1), EVAL_LIMITS.maxTimeoutMs),
    )
    let restarted = false
    const execute = async () => {
      const launch = await this.prepare()
      if (signal.aborted || this.closed) {
        await launch.cleanup()
        signal.throwIfAborted()
        throw new EvalError('closed', 'eval session has ended')
      }
      if (this.worker?.process.alive === false || this.worker?.launch.fingerprint !== launch.fingerprint) {
        await this.stopWorker()
      }
      if (signal.aborted || this.closed) {
        await launch.cleanup()
        signal.throwIfAborted()
        throw new EvalError('closed', 'eval session has ended')
      }
      if (this.worker === undefined) {
        restarted = this.used
        this.used = true
        const process = new KernelProcess(launch, {
          frame: (frame) => cell.receive(frame, (reply) => process.send(reply)),
          output: (text) => cell.output.append(text),
          failure: (error) => {
            if (this.worker?.process === process) this.active?.completed.reject(error)
          },
        })
        this.worker = { process, launch }
      } else {
        await launch.cleanup()
      }
      const process = this.worker.process
      await process.ready
      signal.throwIfAborted()
      // Keep old output attached to its original cell throughout preparation
      // and replacement. Only transfer the lease immediately before execution.
      process.onFrame = (frame) => cell.receive(frame, (reply) => process.send(reply))
      process.onOutput = (text) => cell.output.append(text)
      process.send({ type: 'run', cellId: cell.id, code })
      await cell.completed.promise
    }
    // completed can reject during startup, before execute awaits it.
    void cell.completed.promise.catch((error: unknown) => controller.abort(error))
    const running = execute()
    try {
      await Promise.race([running, failure])
      return {
        text: (restarted ? '[eval kernel restarted; previous bindings lost]\n' : '') + cell.output.render(),
        isError: false,
        truncated: cell.output.truncated,
        restarted,
      }
    } catch (error) {
      controller.abort(error)
      // The child reported a thrown or rejected cell after settling its tool
      // calls, so the process is healthy and its bindings are still valid.
      const cellFailed = error instanceof EvalError && error.kind === 'cell'
      if (!cellFailed) await this.stopWorker()
      cell.output.append('\n' + (error instanceof Error ? error.message : String(error)))
      return {
        text:
          cell.output.render() +
          (cellFailed ? '\n[eval cell failed; kernel and bindings kept]' : '\n[eval kernel stopped; bindings lost]'),
        isError: true,
        truncated: cell.output.truncated,
        restarted,
      }
    } finally {
      clearTimeout(timeout)
      this.active = undefined
      this.controller = undefined
      if (!this.closed)
        this.idle = setTimeout(() => {
          void this.stopWorker()
        }, this.idleMs)
      this.idle?.unref()
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return await this.disposal
    this.closed = true
    clearTimeout(this.idle)
    this.controller?.abort(new EvalError('closed', 'eval session ended; bindings lost'))
    this.disposal = this.stopWorker()
    await this.disposal
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    if (worker === undefined) return await this.stopping
    worker.process.stop()
    const stopped = worker.process.exited.then(worker.launch.cleanup)
    this.stopping = Promise.all([this.stopping, stopped]).then(() => {})
    await this.stopping
  }
}
