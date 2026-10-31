import type { HostFrame, KernelFrame } from './protocol'

export const EVAL_LIMITS = {
  codeBytes: 64 * 1024,
  frameBytes: 1024 * 1024,
  outputBytes: 64 * 1024,
  outputLines: 1000,
  timeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  idleMs: 5 * 60_000,
  calls: 128,
  concurrency: 8,
} as const

export const FRAME_PREFIX = '@typeclaw-eval '
export class EvalError extends Error {
  override readonly name = 'EvalError'
  constructor(
    readonly kind: 'protocol' | 'closed' | 'timeout' | 'busy' | 'refused' | 'cell',
    message: string,
  ) {
    super(message)
  }
}

export function assertNever(value: never): never {
  throw new EvalError('protocol', `unexpected eval frame: ${String(value)}`)
}

export function encodeFrame(frame: HostFrame | KernelFrame): string {
  const line = FRAME_PREFIX + JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(line) > EVAL_LIMITS.frameBytes) {
    throw new EvalError('protocol', 'eval bridge frame exceeds its byte limit')
  }
  return line
}

// Both complete lines and an unterminated flood are bounded before JSON.parse.
export class FrameLines {
  private pending = Buffer.alloc(0)

  push(chunk: Uint8Array): string[] {
    const bytes = Buffer.concat([this.pending, chunk])
    const lines: string[] = []
    let start = 0
    let end = bytes.indexOf(10)
    while (end !== -1) {
      if (end - start > EVAL_LIMITS.frameBytes) throw new EvalError('protocol', 'eval bridge line is too large')
      lines.push(bytes.subarray(start, end).toString('utf8'))
      start = end + 1
      end = bytes.indexOf(10, start)
    }
    if (bytes.length - start > EVAL_LIMITS.frameBytes) {
      throw new EvalError('protocol', 'eval bridge unterminated line is too large')
    }
    this.pending = Buffer.from(bytes.subarray(start))
    return lines
  }
}

export class CellOutput {
  private text = ''
  private bytes = 0
  private lines = 0
  truncated = false

  append(text: string): void {
    if (this.truncated) return
    for (const character of text) {
      const size = Buffer.byteLength(character)
      if (this.bytes + size > EVAL_LIMITS.outputBytes || this.lines >= EVAL_LIMITS.outputLines) {
        this.truncated = true
        return
      }
      this.text += character
      this.bytes += size
      if (character === '\n') this.lines += 1
    }
  }

  render(): string {
    return this.text + (this.truncated ? '\n[eval output truncated: byte or line limit reached]\n' : '')
  }
}
