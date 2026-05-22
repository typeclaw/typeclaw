import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { clearDreamedIds, loadDreamingState, saveDreamingState } from './dreaming-state'
import { newEventId, type StreamEvent, streamEventSchema, timestampFromId } from './stream-events'
import { writeEventsAtomic as defaultWriteEventsAtomic } from './stream-io'

export type MigrationResult = {
  migrated: string[]
  skipped: string[]
  legacyProseCount: number
  fragmentCount: number
  watermarkCount: number
}

export type MigrationLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export type MigrationGit = {
  spawn?: (args: string[], options: { cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type RunMigrationOptions = {
  agentDir: string
  logger: MigrationLogger
  git?: MigrationGit
  writeEventsAtomic?: (path: string, events: readonly StreamEvent[]) => Promise<void>
}

const DAILY_MD_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/
const DAILY_JSONL_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const LEGACY_FRAGMENT_RE =
  /<!-- fragment source=(\S+) entry=(\S+) -->\n## (.+)\n([\s\S]*?)(?=<!-- fragment |<!-- watermark |$)/g
const LEGACY_WATERMARK_RE = /<!-- watermark source=(\S+) entry=(\S+) -->/g

export async function runMigration(options: RunMigrationOptions): Promise<MigrationResult> {
  const memoryDir = join(options.agentDir, 'memory')
  const result: MigrationResult = {
    migrated: [],
    skipped: [],
    legacyProseCount: 0,
    fragmentCount: 0,
    watermarkCount: 0,
  }

  let entries: string[]
  try {
    entries = await readdir(memoryDir)
  } catch {
    return result
  }

  let streamEntries: string[] = []
  try {
    streamEntries = await readdir(join(memoryDir, 'streams'))
  } catch {
    // streams directory doesn't exist yet
  }

  const dates = collectDailyDates([...entries, ...streamEntries])
  for (const date of dates) {
    const mdPath = join(memoryDir, `${date}.md`)
    const jsonlPath = join(memoryDir, 'streams', `${date}.jsonl`)
    const hasMd = existsSync(mdPath)
    const hasJsonl = existsSync(jsonlPath)

    if (hasJsonl && !hasMd) {
      result.skipped.push(date)
      continue
    }

    if (hasJsonl && hasMd) {
      options.logger.warn(`[memory:migration] ${date}: skipped because both .md and .jsonl exist`)
      result.skipped.push(date)
      continue
    }

    if (!hasMd) continue

    const content = await readFile(mdPath, 'utf8')
    const events = parseLegacyMarkdown(content)
    const invalid = findInvalidEvent(events)
    if (invalid !== null) {
      options.logger.error(
        `[memory:migration] ${date}.md: event ${invalid.index + 1} failed validation: ${invalid.reason}`,
      )
      result.skipped.push(date)
      continue
    }

    const counts = countEvents(events)
    try {
      await mkdir(join(memoryDir, 'streams'), { recursive: true })
      await (options.writeEventsAtomic ?? defaultWriteEventsAtomic)(jsonlPath, events)
    } catch (err) {
      options.logger.error(`[memory:migration] ${date}.md: failed to write JSONL: ${describeError(err)}`)
      result.skipped.push(date)
      continue
    }
    await unlink(mdPath)

    result.fragmentCount += counts.fragmentCount
    result.watermarkCount += counts.watermarkCount
    result.legacyProseCount += counts.legacyProseCount
    result.migrated.push(date)
    options.logger.info(
      `[memory:migration] ${date}: ${counts.fragmentCount} fragments, ${counts.watermarkCount} watermarks, ${counts.legacyProseCount} legacy_prose regions`,
    )
  }

  if (result.migrated.length > 0) {
    await resetDreamingWatermarks(options.agentDir, result.migrated)
    await commitMigration(options.agentDir, result.migrated, options.logger, options.git)
  }

  return result
}

function collectDailyDates(entries: readonly string[]): string[] {
  const dates = new Set<string>()
  for (const entry of entries) {
    const md = DAILY_MD_NAME.exec(entry)
    if (md?.[1] !== undefined) dates.add(md[1])
    const jsonl = DAILY_JSONL_NAME.exec(entry)
    if (jsonl?.[1] !== undefined) dates.add(jsonl[1])
  }
  return Array.from(dates).sort()
}

function parseLegacyMarkdown(content: string): StreamEvent[] {
  const events: StreamEvent[] = []
  let cursor = 0

  while (cursor < content.length) {
    const fragment = nextMatch(LEGACY_FRAGMENT_RE, content, cursor)
    const watermark = nextMatch(LEGACY_WATERMARK_RE, content, cursor)
    const next = earliest(fragment, watermark)
    if (next === null) break

    addLegacyProse(events, content.slice(cursor, next.match.index))
    if (next.kind === 'fragment') {
      const id = newEventId()
      events.push({
        type: 'fragment',
        id,
        ts: timestampFromId(id),
        source: next.match[1]!,
        entry: next.match[2]!,
        topic: next.match[3]!,
        body: next.match[4]!,
      })
    } else {
      const id = newEventId()
      events.push({
        type: 'watermark',
        id,
        ts: timestampFromId(id),
        source: next.match[1]!,
        entry: next.match[2]!,
      })
    }
    cursor = next.match.index + next.match[0].length
  }

  addLegacyProse(events, content.slice(cursor))
  return events
}

function addLegacyProse(events: StreamEvent[], text: string): void {
  if (text.trim() === '') return
  events.push({ type: 'legacy_prose', ts: new Date().toISOString(), text, origin: 'migration' })
}

function nextMatch(regex: RegExp, content: string, cursor: number): RegExpExecArray | null {
  regex.lastIndex = cursor
  return regex.exec(content)
}

function earliest(
  fragment: RegExpExecArray | null,
  watermark: RegExpExecArray | null,
): { kind: 'fragment' | 'watermark'; match: RegExpExecArray } | null {
  if (fragment === null && watermark === null) return null
  if (fragment === null) return { kind: 'watermark', match: watermark! }
  if (watermark === null) return { kind: 'fragment', match: fragment }
  return fragment.index <= watermark.index
    ? { kind: 'fragment', match: fragment }
    : { kind: 'watermark', match: watermark }
}

function findInvalidEvent(events: readonly StreamEvent[]): { index: number; reason: string } | null {
  for (let i = 0; i < events.length; i++) {
    const parsed = streamEventSchema.safeParse(events[i])
    if (!parsed.success) {
      return { index: i, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
    }
  }
  return null
}

function countEvents(
  events: readonly StreamEvent[],
): Pick<MigrationResult, 'fragmentCount' | 'watermarkCount' | 'legacyProseCount'> {
  let fragmentCount = 0
  let watermarkCount = 0
  let legacyProseCount = 0
  for (const event of events) {
    if (event.type === 'fragment') fragmentCount++
    if (event.type === 'watermark') watermarkCount++
    if (event.type === 'legacy_prose') legacyProseCount++
  }
  return { fragmentCount, watermarkCount, legacyProseCount }
}

async function resetDreamingWatermarks(agentDir: string, dates: readonly string[]): Promise<void> {
  let state = await loadDreamingState(agentDir)
  const ts = new Date().toISOString()
  for (const date of dates) {
    state = clearDreamedIds(state, date, ts)
  }
  await saveDreamingState(agentDir, state)
}

async function commitMigration(
  agentDir: string,
  dates: readonly string[],
  logger: MigrationLogger,
  git: MigrationGit | undefined,
): Promise<void> {
  const spawn = git?.spawn ?? spawnGit
  const inside = await spawn(['rev-parse', '--is-inside-work-tree'], { cwd: agentDir })
  if (inside.exitCode !== 0) {
    logger.info('[memory:migration] not in a git repo; skipping git commit')
    return
  }

  const jsonlPaths = dates.map((date) => `memory/streams/${date}.jsonl`)
  const addJsonl = await spawn(['add', '--', ...jsonlPaths], { cwd: agentDir })
  if (addJsonl.exitCode !== 0) {
    logger.warn(`[memory:migration] git add failed: ${addJsonl.stderr || addJsonl.stdout}`.trim())
    return
  }

  for (const date of dates) {
    const mdPath = `memory/${date}.md`
    const tracked = await spawn(['ls-files', '--error-unmatch', '--', mdPath], { cwd: agentDir })
    if (tracked.exitCode !== 0) continue
    const addDeletedMd = await spawn(['add', '-u', '--', mdPath], { cwd: agentDir })
    if (addDeletedMd.exitCode !== 0) {
      logger.warn(`[memory:migration] git add failed: ${addDeletedMd.stderr || addDeletedMd.stdout}`.trim())
      return
    }
  }

  const commit = await spawn(
    ['commit', '-m', `memory: migrate ${dates.length} daily stream(s) to JSONL`, '--no-edit'],
    {
      cwd: agentDir,
    },
  )
  if (commit.exitCode !== 0) {
    logger.warn(`[memory:migration] git commit failed: ${commit.stderr || commit.stdout}`.trim())
  }
}

async function spawnGit(
  args: string[],
  options: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
