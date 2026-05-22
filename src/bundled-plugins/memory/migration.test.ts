import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addDreamedIds, loadDreamingState, saveDreamingState } from './dreaming-state'
import { runMigration, type MigrationLogger } from './migration'
import { readEvents } from './stream-io'

describe('runMigration', () => {
  let agentDir: string
  let memoryDir: string
  let messages: { info: string[]; warn: string[]; error: string[] }
  let logger: MigrationLogger

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-memory-migration-'))
    memoryDir = join(agentDir, 'memory')
    await mkdir(join(memoryDir, 'streams'), { recursive: true })
    messages = { info: [], warn: [], error: [] }
    logger = {
      info: (message) => messages.info.push(message),
      warn: (message) => messages.warn.push(message),
      error: (message) => messages.error.push(message),
    }
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('migrates a clean markdown stream to ordered JSONL events', async () => {
    await writeDailyMd(
      '2026-05-16',
      '<!-- fragment source=ses_a entry=entry_1 -->\n## First Topic\nFirst body\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->\n' +
        '<!-- fragment source=ses_b entry=entry_3 -->\n## Second Topic\nSecond body',
    )

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(result.fragmentCount).toBe(2)
    expect(result.watermarkCount).toBe(1)
    expect(result.legacyProseCount).toBe(0)
    expect(existsSync(join(memoryDir, '2026-05-16.md'))).toBe(false)
    expect(existsSync(join(memoryDir, 'streams', '2026-05-16.jsonl'))).toBe(true)

    const events = await readEvents(join(memoryDir, 'streams', '2026-05-16.jsonl'))
    expect(events.map((event) => event.type)).toEqual(['fragment', 'watermark', 'fragment'])
    expect(events[0]).toMatchObject({ source: 'ses_a', entry: 'entry_1', topic: 'First Topic', body: 'First body\n' })
    expect(events[1]).toMatchObject({ source: 'ses_a', entry: 'entry_2' })
    expect(events[2]).toMatchObject({ source: 'ses_b', entry: 'entry_3', topic: 'Second Topic', body: 'Second body' })
  })

  test('preserves interleaved prose as legacy_prose events', async () => {
    await writeDailyMd(
      '2026-05-16',
      'intro prose\n' +
        '<!-- fragment source=ses_a entry=entry_1 -->\n## Topic\nBody\n' +
        'middle prose\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->\n' +
        'tail prose\n',
    )

    const result = await runMigration({ agentDir, logger })

    expect(result.legacyProseCount).toBe(2)
    const events = await readEvents(join(memoryDir, 'streams', '2026-05-16.jsonl'))
    expect(events.map((event) => event.type)).toEqual(['legacy_prose', 'fragment', 'watermark', 'legacy_prose'])
    expect(events[0]).toMatchObject({ text: 'intro prose\n', origin: 'migration' })
    expect(events[3]).toMatchObject({ text: '\ntail prose\n', origin: 'migration' })
  })

  test('skips a date that only has an already-migrated JSONL file', async () => {
    await writeFile(join(memoryDir, 'streams', '2026-05-16.jsonl'), '', 'utf8')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
  })

  test('skips a conflict when markdown and JSONL both exist', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')
    await writeFile(join(memoryDir, 'streams', '2026-05-16.jsonl'), 'existing\n', 'utf8')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
    expect(await readFile(join(memoryDir, '2026-05-16.md'), 'utf8')).toContain('watermark')
    expect(await readFile(join(memoryDir, 'streams', '2026-05-16.jsonl'), 'utf8')).toBe('existing\n')
    expect(messages.warn.some((message) => message.includes('both .md and .jsonl exist'))).toBe(true)
  })

  test('keeps markdown and leaves JSONL absent when the atomic write fails', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    const result = await runMigration({
      agentDir,
      logger,
      writeEventsAtomic: async () => {
        throw new Error('disk full')
      },
    })

    expect(result.migrated).toEqual([])
    expect(result.skipped).toEqual(['2026-05-16'])
    expect(existsSync(join(memoryDir, '2026-05-16.md'))).toBe(true)
    expect(existsSync(join(memoryDir, 'streams', '2026-05-16.jsonl'))).toBe(false)
    expect(messages.error.some((message) => message.includes('disk full'))).toBe(true)
  })

  test('commits migrated streams when the agent directory is a git repo', async () => {
    await initGitRepo(agentDir)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })

    const latest = await git(agentDir, ['log', '--oneline', '-1'])
    expect(latest.stdout).toContain('memory: migrate 1 daily stream(s) to JSONL')
  })

  test('does not throw outside a git repo', async () => {
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    const result = await runMigration({ agentDir, logger })

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(messages.info.some((message) => message.includes('not in a git repo'))).toBe(true)
  })

  test('clears the dreamed-id set for migrated dates so dreaming re-reads the newly-written JSONL', async () => {
    let state = addDreamedIds(await loadDreamingState(agentDir), '2026-05-16', ['stale-id-1', 'stale-id-2'], 'old')
    await saveDreamingState(agentDir, state)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })

    state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-05-16']?.dreamedIds).toEqual([])
  })

  test('leaves dreamed-id sets unchanged for unmigrated dates', async () => {
    let state = addDreamedIds(await loadDreamingState(agentDir), '2026-05-15', ['kept-id'], 'old')
    state = addDreamedIds(state, '2026-05-16', ['will-be-cleared'], 'old')
    await saveDreamingState(agentDir, state)
    await writeDailyMd('2026-05-16', '<!-- watermark source=ses_a entry=entry_1 -->')

    await runMigration({ agentDir, logger })
    state = await loadDreamingState(agentDir)

    expect(state.dreamedThrough['2026-05-15']?.dreamedIds).toEqual(['kept-id'])
    expect(state.dreamedThrough['2026-05-16']?.dreamedIds).toEqual([])
  })

  test('migrates an empty markdown stream to an empty JSONL file', async () => {
    await writeDailyMd('2026-05-16', '')

    const result = await runMigration({ agentDir, logger })

    const jsonl = await readFile(join(memoryDir, 'streams', '2026-05-16.jsonl'), 'utf8')

    expect(result.migrated).toEqual(['2026-05-16'])
    expect(result.fragmentCount).toBe(0)
    expect(result.watermarkCount).toBe(0)
    expect(result.legacyProseCount).toBe(0)
    expect(jsonl).toBe('')
  })

  test('treats malformed fragment markers as legacy prose instead of fixing them', async () => {
    await writeDailyMd(
      '2026-05-16',
      '<!-- fragment source=ses_a entry=entry_1 -->\n# Wrong heading\nBody\n' +
        '<!-- watermark source=ses_a entry=entry_2 -->',
    )

    const result = await runMigration({ agentDir, logger })
    const events = await readEvents(join(memoryDir, 'streams', '2026-05-16.jsonl'))

    expect(result.legacyProseCount).toBe(1)
    expect(result.watermarkCount).toBe(1)
    expect(events.map((event) => event.type)).toEqual(['legacy_prose', 'watermark'])
  })

  async function writeDailyMd(date: string, content: string): Promise<void> {
    await writeFile(join(memoryDir, `${date}.md`), content, 'utf8')
  }
})

async function initGitRepo(cwd: string): Promise<void> {
  await git(cwd, ['init'])
  await git(cwd, ['config', 'user.email', 'user@example.com'])
  await git(cwd, ['config', 'user.name', 'Test User'])
  await git(cwd, ['commit', '--allow-empty', '-m', 'initial'])
}

async function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  return { exitCode, stdout, stderr }
}
