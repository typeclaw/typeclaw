import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReadabilityDetailedResult } from './readability'

export type ReadabilityChildRequest = { html: string; url: string }
export type ReadabilityChildResponse = { ok: true; result: ReadabilityDetailedResult } | { ok: false; message: string }

export type ReadabilityChildOutcome =
  | { kind: 'ok'; result: ReadabilityDetailedResult }
  | { kind: 'error'; message: string }
  | { kind: 'memory'; childRssBytes: number | null; availableBytes: number | null }
  | { kind: 'aborted' }
  | { kind: 'crashed'; exitCode: number | null; signalCode: string | null }

type StopReason = Extract<ReadabilityChildOutcome, { kind: 'memory' | 'aborted' }>

export type MemoryProbe = {
  readChildRssBytes: (pid: number) => number | null
  readAvailableBytes: () => number | null
}

export type ReadabilityChildOptions = {
  signal?: AbortSignal
  probe?: MemoryProbe
  onSpawn?: (pid: number) => void
}

export const MEMORY_RESERVE_BYTES = 512 * 1024 * 1024
export const MIN_KILLABLE_CHILD_RSS_BYTES = 256 * 1024 * 1024
const POLL_INTERVAL_MS = 100
const CHILD_ENTRY = join(import.meta.dir, 'readability-child.ts')

export const READABILITY_MEMORY_MESSAGE =
  'Readability extraction stopped: parsing this page would exhaust the memory available to the agent. Browser retrieval may be needed for this page.'
export const READABILITY_CRASH_MESSAGE = 'Readability extraction failed: the page parser exited unexpectedly.'
export const READABILITY_ABORT_MESSAGE = 'Readability extraction was aborted.'

// jsdom can allocate tens of gigabytes inside one synchronous getComputedStyle()
// call (a 289KB Starlight docs page reached 24-32GB), and memory it frees is not
// returned to the OS, so every in-process parse ratchets the runtime's RSS. A
// disposable child process returns all of it on exit and can be killed mid-call,
// which neither the abort signal nor any in-process limit can do.
export async function applyReadabilityIsolated(
  html: string,
  url: string,
  signal?: AbortSignal,
): Promise<ReadabilityDetailedResult> {
  const outcome = await runReadabilityChild({ html, url }, signal === undefined ? {} : { signal })
  switch (outcome.kind) {
    case 'ok':
      return outcome.result
    case 'error':
      throw new Error(outcome.message)
    case 'memory':
      console.warn(
        `[webfetch] readability parser stopped near memory exhaustion host=${hostOf(url)} child_rss_mb=${toMb(outcome.childRssBytes)} available_mb=${toMb(outcome.availableBytes)}`,
      )
      throw new Error(READABILITY_MEMORY_MESSAGE)
    case 'aborted':
      throw new Error(READABILITY_ABORT_MESSAGE)
    case 'crashed':
      console.warn(
        `[webfetch] readability parser exited unexpectedly host=${hostOf(url)} exit_code=${outcome.exitCode} signal=${outcome.signalCode}`,
      )
      throw new Error(READABILITY_CRASH_MESSAGE)
  }
}

export async function runReadabilityChild(
  request: ReadabilityChildRequest,
  options: ReadabilityChildOptions = {},
): Promise<ReadabilityChildOutcome> {
  const { signal } = options
  if (signal?.aborted) return { kind: 'aborted' }
  const probe = options.probe ?? defaultMemoryProbe

  const child = Bun.spawn([process.execPath, '--smol', CHILD_ENTRY], {
    stdin: new Blob([JSON.stringify(request)]),
    stdout: 'pipe',
    stderr: 'inherit',
    env: {},
  })

  let stop = null as StopReason | null
  const kill = (reason: StopReason): void => {
    if (stop !== null) return
    stop = reason
    child.kill('SIGKILL')
  }
  const onAbort = (): void => kill({ kind: 'aborted' })
  signal?.addEventListener('abort', onAbort, { once: true })
  const watchdog = setInterval(() => {
    const childRssBytes = probe.readChildRssBytes(child.pid)
    const availableBytes = probe.readAvailableBytes()
    if (shouldStopChild(childRssBytes, availableBytes)) kill({ kind: 'memory', childRssBytes, availableBytes })
  }, POLL_INTERVAL_MS)
  options.onSpawn?.(child.pid)
  if (signal?.aborted) onAbort()

  try {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])
    if (stop !== null) return stop
    if (child.exitCode !== 0) {
      // Anything that SIGKILLs the parser without us asking is the kernel OOM
      // killer: the child raised its own oom_score_adj so it is chosen first.
      if (child.signalCode === 'SIGKILL') return { kind: 'memory', childRssBytes: null, availableBytes: null }
      return { kind: 'crashed', exitCode: child.exitCode, signalCode: child.signalCode }
    }
    const response = parseResponse(stdout)
    if (response === null) return { kind: 'crashed', exitCode: child.exitCode, signalCode: child.signalCode }
    return response.ok ? { kind: 'ok', result: response.result } : { kind: 'error', message: response.message }
  } finally {
    clearInterval(watchdog)
    signal?.removeEventListener('abort', onAbort)
  }
}

// Stopping only when the machine is about to run out keeps every parse that
// succeeds today succeeding: a parse is cut short only where it would otherwise
// have taken the agent runtime down with it. The RSS floor keeps a normal-sized
// parse alive when something else is what is exhausting memory.
export function shouldStopChild(childRssBytes: number | null, availableBytes: number | null): boolean {
  if (childRssBytes === null || availableBytes === null) return false
  return childRssBytes >= MIN_KILLABLE_CHILD_RSS_BYTES && availableBytes < MEMORY_RESERVE_BYTES
}

export const defaultMemoryProbe: MemoryProbe = {
  readChildRssBytes: (pid) => {
    if (process.platform !== 'linux') return null
    const status = readOptional(`/proc/${pid}/status`)
    const kb = status?.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]
    return kb === undefined ? null : Number(kb) * 1024
  },
  readAvailableBytes: () => (process.platform === 'linux' ? readLinuxAvailableBytes() : null),
}

// The tighter of two ceilings: the container's cgroup limit, and the host or VM
// itself. Both matter because sibling containers can exhaust a shared Docker VM
// while every container is still under its own limit, which is how this OOM
// actually happened.
export function readLinuxAvailableBytes(root = ''): number | null {
  const candidates: number[] = []
  const meminfoKb = readOptional(`${root}/proc/meminfo`)?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1]
  if (meminfoKb !== undefined) candidates.push(Number(meminfoKb) * 1024)

  const max = readOptional(`${root}/sys/fs/cgroup/memory.max`)?.trim()
  const current = readOptional(`${root}/sys/fs/cgroup/memory.current`)?.trim()
  if (max !== undefined && max !== 'max' && current !== undefined) {
    // Inactive page cache is reclaimable before the cgroup OOMs, the same
    // adjustment `docker stats` applies.
    const inactiveFile = readOptional(`${root}/sys/fs/cgroup/memory.stat`)?.match(/^inactive_file (\d+)$/m)?.[1]
    candidates.push(Number(max) - Number(current) + Number(inactiveFile ?? 0))
  }

  return candidates.length === 0 ? null : Math.min(...candidates)
}

function parseResponse(stdout: string): ReadabilityChildResponse | null {
  try {
    return JSON.parse(stdout) as ReadabilityChildResponse
  } catch {
    return null
  }
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

function toMb(bytes: number | null): string {
  return bytes === null ? '?' : String(Math.round(bytes / (1024 * 1024)))
}
