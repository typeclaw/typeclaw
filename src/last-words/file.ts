import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

export type ObservedExit = {
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
// with an in-flight tick.
export function writeLastWords(agentDir: string, file: LastWordsFile): void {
  const path = lastWordsPath(agentDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
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
// stopped, because only one runtime owns an agent directory at a time. An entry
// that started after the exit belongs to a newer run and is left alone. An
// operator stop (`typeclaw stop` ran `docker stop` itself) is a clean stop even
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
  if (entry.status !== 'alive') return file
  if (parseInstant(entry.run.startedAt) > parseInstant(exit.finishedAt)) return file
  if (options.operatorStop === true) {
    return replaceEntry(file, index, { ...entry, status: 'stopped', words: null })
  }
  return replaceEntry(file, index, { ...entry, status: 'died', death: { ...exit, observedBy } })
}

// Host lifecycle steps call this best-effort: a failure to record last words
// must never block start, stop, or the daemon's probe loop.
export function sealExitForAgent(
  agentDir: string,
  exit: ObservedExit,
  observedBy: LastWordsDeath['observedBy'],
  options: { operatorStop?: boolean } = {},
): void {
  try {
    const before = readLastWords(agentDir)
    const after = sealExit(before, exit, observedBy, options)
    if (after !== before) writeLastWords(agentDir, after)
  } catch (error) {
    console.warn(`[last-words] could not seal exit: ${error instanceof Error ? error.message : String(error)}`)
  }
}
