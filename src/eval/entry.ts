// Container-stage child entry. Never import this into the trusted runtime:
// arbitrary code, including native Bun APIs, executes only inside bwrap.
import { start } from 'node:repl'
import { PassThrough, Writable } from 'node:stream'
import { format } from 'node:util'

import type { HostFrame, KernelFrame } from './protocol'
import { topLevelDeclarationsToVar } from './redeclare'
import { EVAL_LIMITS, EvalError, FrameLines, FRAME_PREFIX, encodeFrame, assertNever } from './wire'

const write = process.stdout.write.bind(process.stdout)
// A leading delimiter also terminates ordinary stdout writes that omitted a
// newline. Raw output cannot accidentally swallow the following control frame.
const send = (frame: KernelFrame) => write('\n' + encodeFrame(frame))
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
const outstanding = new Set<Promise<unknown>>()
let cellId: string | undefined
let sequence = 0
let rejectEvaluation: ((error: unknown) => void) | undefined

function print(...values: unknown[]): void {
  if (cellId === undefined) return
  const text = format(...values) + '\n'
  // Chunk before JSON framing so large printed values still reach the host's
  // output cap instead of overflowing a single protocol frame.
  let chunk = ''
  for (const character of text) {
    chunk += character
    if (chunk.length >= 4096) {
      send({ type: 'output', cellId, text: chunk })
      chunk = ''
    }
  }
  if (chunk !== '') send({ type: 'output', cellId, text: chunk })
}

type ToolArgs = Extract<KernelFrame, { type: 'tool-call' }>['args']
const tool = new Proxy<Record<string, (args: ToolArgs) => Promise<unknown>>>(
  {},
  {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined
      return (args: ToolArgs) => {
        const activeCellId = cellId
        if (activeCellId === undefined) return Promise.reject(new EvalError('closed', 'no active eval cell'))
        const id = String(++sequence)
        const result = new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject })
          send({ type: 'tool-call', cellId: activeCellId, id, name, args })
        })
        outstanding.add(result)
        void result.then(
          () => outstanding.delete(result),
          () => outstanding.delete(result),
        )
        return result
      }
    },
  },
)

async function parallel<T>(thunks: readonly (() => Promise<T>)[]): Promise<T[]> {
  let next = 0
  const values: T[] = []
  const failures: unknown[] = []
  // A failed cell keeps the kernel, so every worker must settle before the
  // failure propagates; a still-sleeping worker would otherwise dispatch tool
  // calls under the next cell's id.
  await Promise.all(
    Array.from({ length: Math.min(EVAL_LIMITS.concurrency, thunks.length) }, async () => {
      while (next < thunks.length && failures.length === 0) {
        const index = next++
        const thunk = thunks[index]
        if (thunk === undefined) continue
        try {
          values[index] = await thunk()
        } catch (error) {
          failures.push(error)
        }
      }
    }),
  )
  if (failures.length > 0) throw failures[0]
  return values
}

// Printing a whole tool result dumps its content array and details into the
// transcript, defeating the point of a cell. text() pulls just the text parts.
function text(result: unknown, maxChars = 4000): string {
  const content = (result as { content?: unknown } | null)?.content
  const joined = Array.isArray(content)
    ? content
        .filter(
          (part): part is { type: 'text'; text: string } => part?.type === 'text' && typeof part.text === 'string',
        )
        .map((part) => part.text)
        .join('\n')
    : typeof result === 'string'
      ? result
      : format(result)
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…[${joined.length - maxChars} more chars]` : joined
}

const replOptions = {
  input: new PassThrough(),
  output: new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      if (cellId !== undefined) send({ type: 'output', cellId, text: chunk.toString('utf8') })
      callback()
    },
  }),
  terminal: false,
  prompt: '',
  // Bun's Node-compatible REPL routes uncaught awaited errors here instead of
  // invoking eval's completion callback. Subscribe before executing each cell.
  handleError(error: unknown) {
    if (rejectEvaluation === undefined) process.exit(1)
    rejectEvaluation(error)
    return 'ignore' as const
  },
}
const repl = start(replOptions)
Object.assign(repl.context, {
  tool,
  parallel,
  print,
  text,
  display: print,
  console: { log: print, info: print, warn: print, error: print, debug: print },
})

async function run(id: string, code: string): Promise<void> {
  if (cellId !== undefined) throw new EvalError('busy', 'eval kernel is busy')
  cellId = id
  const failure = await evaluate(topLevelDeclarationsToVar(code))
  // A forgotten await must not detach tool work from the foreground cell.
  await Promise.allSettled(outstanding)
  cellId = undefined
  send({ type: 'done', cellId: id, ...(failure === undefined ? {} : { error: failure.slice(0, 4096) }) })
}

async function evaluate(code: string): Promise<string | undefined> {
  try {
    await new Promise<void>((resolve, reject) => {
      rejectEvaluation = reject
      repl.eval(code + '\n', repl.context, 'eval-cell', (error: Error | null) => {
        if (error !== null && error !== undefined) reject(error)
        else resolve()
      })
    })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    rejectEvaluation = undefined
  }
}

const lines = new FrameLines()
// No package imports in the child: dev mode exposes src/, not a checkout's
// node_modules. The trusted host has already constructed these frames; the
// reverse direction is fully schema-validated by the host before dispatch.
function parseHostFrame(line: string): HostFrame {
  const value: unknown = JSON.parse(line)
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new EvalError('protocol', 'invalid host frame')
  }
  switch (value.type) {
    case 'run':
      if ('cellId' in value && typeof value.cellId === 'string' && 'code' in value && typeof value.code === 'string') {
        return { type: 'run', cellId: value.cellId, code: value.code }
      }
      break
    case 'tool-result':
      if ('id' in value && typeof value.id === 'string' && 'value' in value) {
        return { type: 'tool-result', id: value.id, value: value.value }
      }
      break
    case 'tool-error':
      if ('id' in value && typeof value.id === 'string' && 'error' in value && typeof value.error === 'string') {
        return { type: 'tool-error', id: value.id, error: value.error }
      }
      break
  }
  throw new EvalError('protocol', 'invalid host frame')
}
process.stdin.on('data', (chunk: Buffer) => {
  for (const line of lines.push(chunk)) {
    if (!line.startsWith(FRAME_PREFIX)) throw new EvalError('protocol', 'invalid host frame')
    const frame = parseHostFrame(line.slice(FRAME_PREFIX.length))
    switch (frame.type) {
      case 'run':
        void run(frame.cellId, frame.code)
        break
      case 'tool-result':
        pending.get(frame.id)?.resolve(frame.value)
        pending.delete(frame.id)
        break
      case 'tool-error':
        pending.get(frame.id)?.reject(new EvalError('refused', frame.error))
        pending.delete(frame.id)
        break
      default:
        assertNever(frame)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
send({ type: 'ready' })
