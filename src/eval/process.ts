import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { withToolOomPriorityCommand } from '@/container/tool-oom-priority'

import {
  EvalError,
  FrameLines,
  FRAME_PREFIX,
  encodeFrame,
  kernelFrameSchema,
  type HostFrame,
  type KernelFrame,
} from './protocol'
import { assertNever } from './wire'

export type KernelLaunch = {
  readonly command: string
  readonly cwd: string
  readonly env: Record<string, string>
  readonly fingerprint: string
  readonly cleanup: () => Promise<void>
}

export class KernelProcess {
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  onFrame: (frame: KernelFrame) => void
  onOutput: (text: string) => void
  alive = true
  private readonly child: ChildProcessWithoutNullStreams

  constructor(
    launch: KernelLaunch,
    callbacks: {
      readonly frame: (frame: KernelFrame) => void
      readonly output: (text: string) => void
      readonly failure: (error: Error) => void
    },
  ) {
    const ready = Promise.withResolvers<void>()
    this.ready = ready.promise
    this.onFrame = callbacks.frame
    this.onOutput = callbacks.output
    // exec retains the supervised PID. The new outer process group also covers
    // unshare's helper in real-proc mode; bwrap's PID namespace and
    // --die-with-parent own teardown of processes that create their own groups.
    this.child = spawn('bash', ['-c', withToolOomPriorityCommand(`exec ${launch.command}`)], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    const lines = new FrameLines()
    const fail = (error: Error) => {
      ready.reject(error)
      callbacks.failure(error)
      this.stop()
    }
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const line of lines.push(chunk)) {
          if (line === '') continue
          if (!line.startsWith(FRAME_PREFIX)) {
            this.onOutput(line + '\n')
            continue
          }
          const frame = kernelFrameSchema.parse(JSON.parse(line.slice(FRAME_PREFIX.length)))
          switch (frame.type) {
            case 'ready':
              ready.resolve()
              break
            case 'output':
            case 'tool-call':
            case 'done':
              this.onFrame(frame)
              break
            default:
              assertNever(frame)
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new EvalError('protocol', String(error)))
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => this.onOutput(chunk.toString('utf8')))
    this.child.stdin.on('error', fail)
    this.child.on('error', fail)
    this.exited = new Promise((resolve) => {
      this.child.on('close', () => {
        this.alive = false
        const error = new EvalError('closed', 'eval kernel exited; bindings lost')
        ready.reject(error)
        callbacks.failure(error)
        resolve()
      })
    })
  }

  send(frame: HostFrame): void {
    this.child.stdin.write(encodeFrame(frame))
  }

  stop(): void {
    if (!this.alive) return
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
}
