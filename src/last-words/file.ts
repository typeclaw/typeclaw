import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'
import { z } from 'zod'

// `.typeclaw/last-words.json`: what the agent was doing when its container
// died. A SIGKILLed runtime cannot write anything, so the runtime keeps its
// words current while alive, and the host stamps the cause of death after the
// fact. The two never write concurrently: the host only seals an entry once
// its container has stopped.
//
// Words describe shape, never content: origin keys, tool names, process kinds,
// and sizes. Message text, tool arguments, URLs, and env values never land here.

export const LAST_WORDS_ENTRY_CAP = 20

const turnSchema = z.object({
  origin: z.enum(['tui', 'channel', 'cron', 'subagent', 'system']),
  key: z.string(),
  startedAt: z.string(),
  tool: z.string().optional(),
})

const childSchema = z.object({
  kind: z.enum(['readability', 'sandbox', 'browser', 'coding-agent', 'other']),
  rssMb: z.number(),
})

const wordsSchema = z.object({
  memory: z.object({
    currentMb: z.number().nullable(),
    limitMb: z.number().nullable(),
    oomKills: z.number().nullable(),
    recent: z.array(z.object({ at: z.string(), currentMb: z.number() })),
  }),
  runtime: z.object({ rssMb: z.number(), heapUsedMb: z.number(), externalMb: z.number() }),
  turns: z.array(turnSchema),
  children: z.array(childSchema),
})

const deathSchema = z.object({
  finishedAt: z.string(),
  exitCode: z.number(),
  oomKilled: z.boolean(),
  reason: z.string().nullable(),
  log: z.string().nullable(),
  observedBy: z.enum(['hostd', 'start', 'stop']),
})

const runSchema = z.object({
  containerId: z.string().nullable(),
  startedAt: z.string(),
  typeclawVersion: z.string(),
})

const entrySchema = z.object({
  run: runSchema,
  status: z.enum(['alive', 'stopped', 'died', 'vanished']),
  writtenAt: z.string(),
  words: wordsSchema.nullable(),
  death: deathSchema.optional(),
})

const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) })

export type LastWordsTurn = z.infer<typeof turnSchema>
export type LastWordsChild = z.infer<typeof childSchema>
export type LastWords = z.infer<typeof wordsSchema>
export type LastWordsDeath = z.infer<typeof deathSchema>
export type LastWordsRun = z.infer<typeof runSchema>
export type LastWordsEntry = z.infer<typeof entrySchema>
export type LastWordsFile = z.infer<typeof fileSchema>

// `containerId` is the full Docker ID and `startedAt` the container's own start
// time: together they identify one execution of a container, which keeps its ID
// across restarts.
export type ObservedExit = {
  containerId: string
  startedAt: string
  finishedAt: string
  exitCode: number
  oomKilled: boolean
  reason: string | null
  log: string | null
}

export function lastWordsPath(agentDir: string): string {
  return join(agentDir, '.typeclaw', 'last-words.json')
}

const EMPTY: LastWordsFile = { version: 1, entries: [] }

// A missing, unreadable, or malformed file reads as empty: last words are a
// diagnostic, and a corrupt one must never block boot or a host lifecycle step.
export function readLastWords(agentDir: string): LastWordsFile {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(lastWordsPath(agentDir), 'utf8')))
    return parsed.success ? parsed.data : EMPTY
  } catch {
    return EMPTY
  }
}

// Synchronous temp-file + rename so a reader (or the host after a kill) only
// ever sees a complete file, and so the graceful-stop write cannot interleave
// with an in-flight tick. The staging name is fixed so the sandbox masks it like
// the file itself: a kill between write and rename leaves it behind. Writers
// never stage concurrently: the runtime writes only while its container lives,
// and host seals serialize on the agent's lock.
export function writeLastWords(agentDir: string, file: LastWordsFile): void {
  const path = lastWordsPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.tmp`
  writeFileSync(staging, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(staging, path)
}

function sameRun(a: LastWordsRun, b: LastWordsRun): boolean {
  return a.startedAt === b.startedAt && a.containerId === b.containerId
}

function replaceEntry(file: LastWordsFile, index: number, entry: LastWordsEntry): LastWordsFile {
  return { ...file, entries: file.entries.map((current, i) => (i === index ? entry : current)) }
}

function findAlive(file: LastWordsFile, run: LastWordsRun): number {
  return file.entries.findIndex((entry) => entry.status === 'alive' && sameRun(entry.run, run))
}

// Boot: an earlier run still marked alive ended without the host observing its
// exit (a manual `docker rm`, a host reboot, a Docker-level restart). Its words
// are kept; its cause stays unknown.
export function openRun(file: LastWordsFile, run: LastWordsRun, now: string): LastWordsFile {
  const entries = file.entries.map((entry) =>
    entry.status === 'alive' ? { ...entry, status: 'vanished' as const } : entry,
  )
  entries.push({ run, status: 'alive', writtenAt: now, words: null })
  return { ...file, entries: entries.slice(-LAST_WORDS_ENTRY_CAP) }
}

export function recordWords(file: LastWordsFile, run: LastWordsRun, words: LastWords, now: string): LastWordsFile {
  const index = findAlive(file, run)
  if (index === -1) return file
  return replaceEntry(file, index, { ...file.entries[index]!, words, writtenAt: now })
}

// A clean shutdown is not a death, so nothing about it is worth keeping.
export function closeRun(file: LastWordsFile, run: LastWordsRun, now: string): LastWordsFile {
  const index = findAlive(file, run)
  if (index === -1) return file
  return replaceEntry(file, index, { ...file.entries[index]!, status: 'stopped', words: null, writtenAt: now })
}

// Docker reports nanosecond fractions, which Date.parse does not reliably accept.
function parseInstant(value: string): number {
  return Date.parse(value.replace(/(\.\d{3})\d+/, '$1'))
}

// Host: the newest entry still alive belongs to the container that just
// stopped, because only one runtime owns an agent directory at a time, but only
// when it was recorded by that execution: same container, and booted between the
// container's start and its exit. A run from an earlier execution of the same
// container whose own exit went unobserved is not paired with a later boot that
// died before recording anything. An operator stop (`typeclaw stop` ran `docker stop` itself) is a clean stop even
// when Docker had to SIGKILL a slow shutdown. A later observer of the same exit
// may fill in the archived log path an earlier one did not have.
export function sealExit(
  file: LastWordsFile,
  exit: ObservedExit,
  observedBy: LastWordsDeath['observedBy'],
  options: { operatorStop?: boolean } = {},
): LastWordsFile {
  const index = file.entries.length - 1
  const entry = file.entries[index]
  if (entry === undefined) return file
  if (entry.status === 'died' && entry.death?.finishedAt === exit.finishedAt) {
    if (entry.death.log !== null || exit.log === null) return file
    return replaceEntry(file, index, { ...entry, death: { ...entry.death, log: exit.log } })
  }
  if (entry.status !== 'alive' || !recordedBy(entry.run, exit)) return file
  if (options.operatorStop === true) {
    return replaceEntry(file, index, { ...entry, status: 'stopped', words: null })
  }
  const { finishedAt, exitCode, oomKilled, reason, log } = exit
  return replaceEntry(file, index, {
    ...entry,
    status: 'died',
    death: { finishedAt, exitCode, oomKilled, reason, log, observedBy },
  })
}

function recordedBy(run: LastWordsRun, exit: ObservedExit): boolean {
  const bootedAt = parseInstant(run.startedAt)
  return (
    (run.containerId === null || exit.containerId.startsWith(run.containerId)) &&
    bootedAt >= parseInstant(exit.startedAt) &&
    bootedAt <= parseInstant(exit.finishedAt)
  )
}

export type SealIo = {
  read: (agentDir: string) => Promise<LastWordsFile>
  write: (agentDir: string, file: LastWordsFile) => void
  serialize: (agentDir: string, operation: () => Promise<void>) => Promise<void>
}

const LOCK_RETRIES = { retries: 600, factor: 1, minTimeout: 10, maxTimeout: 10, randomize: false } as const

// hostd's probe and a standalone `start` or `stop` can observe the same exit
// from different processes. Each seal rereads under the agent's lock, so a
// logless seal that started first cannot overwrite a seal that added the log.
export const DEFAULT_SEAL_IO: SealIo = {
  read: async (agentDir) => readLastWords(agentDir),
  write: writeLastWords,
  serialize: async (agentDir, operation) => {
    const path = lastWordsPath(agentDir)
    await mkdir(dirname(path), { recursive: true })
    const release = await lockfile.lock(path, { realpath: false, stale: 10_000, update: 2_000, retries: LOCK_RETRIES })
    try {
      await operation()
    } finally {
      await release().catch(() => undefined)
    }
  },
}

// Host lifecycle steps call this best-effort: a failure to record last words
// must never block start, stop, or the daemon's probe loop.
export async function sealExitForAgent(
  agentDir: string,
  exit: ObservedExit,
  observedBy: LastWordsDeath['observedBy'],
  options: { operatorStop?: boolean } = {},
  io: SealIo = DEFAULT_SEAL_IO,
): Promise<void> {
  try {
    await io.serialize(agentDir, async () => {
      const before = await io.read(agentDir)
      const after = sealExit(before, exit, observedBy, options)
      if (after !== before) io.write(agentDir, after)
    })
  } catch (error) {
    console.warn(`[last-words] could not seal exit: ${error instanceof Error ? error.message : String(error)}`)
  }
}
