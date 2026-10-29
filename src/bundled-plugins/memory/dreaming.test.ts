import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'

import {
  commitMemorySnapshot,
  compactDailyStreams,
  createDreamingSubagent,
  DREAM_EMOJI_POOL,
  deleteRedundantDreamedCitedStreamVectors,
  type DreamingLogger,
  type DreamingPayload,
  isDreamingPayload,
} from './dreaming'
import { addDreamedIds, DREAMING_STATE_FILE, emptyState, getDreamedIds, loadDreamingState } from './dreaming-state'
import { renderShard } from './frontmatter'
import { parseReference, renderReference, type ReferenceFrontmatter } from './references/frontmatter'
import { EMBEDDING_MODEL_ID } from './vector/embedder'
import type { EmbedFn } from './vector/hybrid'
import { referencePassages } from './vector/passages'
import { VectorStore, type VectorRow } from './vector/store'

const silentLogger: DreamingLogger = { info: () => {}, warn: () => {}, error: () => {} }

function fragmentLine(entry: string, topic = `topic-${entry}`, body = `body ${entry}`): string {
  return `${JSON.stringify({ type: 'fragment', id: `f-${entry}`, ts: '2026-05-16T12:00:00.000Z', source: 'ses_test', entry, topic, body })}\n`
}

function watermarkLine(entry: string): string {
  return `${JSON.stringify({ type: 'watermark', id: `w-${entry}`, ts: '2026-05-16T12:00:00.000Z', source: 'ses_test', entry })}\n`
}

function fragmentLineWithReferences(entry: string, references: string[]): string {
  return `${JSON.stringify({ type: 'fragment', id: `f-${entry}`, ts: '2026-05-16T12:00:00.000Z', source: 'ses_test', entry, topic: `topic-${entry}`, body: `body ${entry}`, references })}\n`
}

function legacyProseLine(body = 'legacy prose'): string {
  return `${JSON.stringify({ type: 'legacy_prose', id: 'legacy-1', ts: '2026-05-16T12:00:00.000Z', body })}\n`
}

function topicShard(slug: string): string {
  return join(agentDir, 'memory', 'topics', `${slug}.md`)
}

function streamFile(date: string): string {
  return join(agentDir, 'memory', 'streams', `${date}.jsonl`)
}

function legacyStreamFile(date: string): string {
  return join(agentDir, 'memory', `${date}.jsonl`)
}

function referenceFile(slug: string): string {
  return join(agentDir, 'memory', 'references', `${slug}.md`)
}

async function writeTopicShard(slug: string, text: string): Promise<void> {
  await mkdir(join(agentDir, 'memory', 'topics'), { recursive: true })
  await writeFile(topicShard(slug), text)
}

async function writeReference(slug: string, text: string): Promise<void> {
  await mkdir(join(agentDir, 'memory', 'references'), { recursive: true })
  await writeFile(referenceFile(slug), text)
}

function referenceText(overrides: Partial<ReferenceFrontmatter> = {}, body = 'reference body'): string {
  const created = overrides.created ?? isoDaysAgo(1)
  return renderReference(
    {
      title: overrides.title ?? 'Reference',
      origin: overrides.origin ?? 'episode',
      created,
      lastAccessed: overrides.lastAccessed ?? created,
      accessCount: overrides.accessCount ?? 0,
      pinned: overrides.pinned ?? false,
      demoted: overrides.demoted ?? false,
      tags: overrides.tags ?? [],
    },
    body,
  )
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function shardText(
  heading: string,
  body: string,
  options: { cites?: number; days?: number; lastReinforced?: string; tags?: string[] } = {},
): string {
  return renderShard(
    {
      heading,
      cites: options.cites ?? 0,
      days: options.days ?? 0,
      lastReinforced: options.lastReinforced ?? '2026-01-01',
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
    },
    body,
  )
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dream-'))
  await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

type CapturedRunSession = {
  prompts: string[]
  runSession: RunSession
}

function captureRunSession(): CapturedRunSession {
  const prompts: string[] = []
  const runSession: RunSession = async (override) => {
    if (override?.userPrompt !== undefined) prompts.push(override.userPrompt)
  }
  return { prompts, runSession }
}

async function invokeDreaming(
  agentDir: string,
  options: {
    commitMemory?: (cwd: string) => Promise<void>
    logger?: DreamingLogger
    runSession?: RunSession
    throwOnRunSession?: boolean
    vectorEmbedFn?: EmbedFn
  } = {},
): Promise<{ prompts: string[] }> {
  const subagent = createDreamingSubagent({
    commitMemory: options.commitMemory ?? (async () => {}),
    logger: options.logger ?? silentLogger,
    ...(options.vectorEmbedFn !== undefined ? { vectorEmbedFn: options.vectorEmbedFn } : {}),
  })
  const captured = captureRunSession()
  const runSession = options.throwOnRunSession
    ? async () => {
        throw new Error('LLM blew up')
      }
    : (options.runSession ?? captured.runSession)

  const ctx: SubagentContext<DreamingPayload> = {
    userPrompt: '',
    agentDir,
    payload: { agentDir },
  }
  await subagent.handler!(ctx, runSession)
  return { prompts: captured.prompts }
}

describe('isDreamingPayload', () => {
  test('accepts a payload with agentDir', () => {
    expect(isDreamingPayload({ agentDir: '/some/path' })).toBe(true)
  })

  test('rejects null and missing/empty agentDir', () => {
    expect(isDreamingPayload(null)).toBe(false)
    expect(isDreamingPayload({})).toBe(false)
    expect(isDreamingPayload({ agentDir: '' })).toBe(false)
    expect(isDreamingPayload({ agentDir: 42 })).toBe(false)
  })
})

describe('dreaming subagent declarations', () => {
  test('declares an inFlightKey that keys on agentDir', () => {
    const sub = createDreamingSubagent()
    expect(sub.inFlightKey).toBeDefined()
    expect(sub.inFlightKey!({ agentDir: '/x' })).toBe('/x')
  })

  test('registers the delete_topic_shard custom tool for shard cleanup', () => {
    const sub = createDreamingSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools!.length).toBe(1)
    expect(sub.customTools![0]?.description).toContain('Delete a single topic shard')
  })

  test('declares a defensive tool-result byte budget on the read tool so a runaway multi-day stream read cannot balloon subagent token cost', () => {
    const sub = createDreamingSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget!.maxTotalBytes).toBeGreaterThanOrEqual(128 * 1024)
    expect(sub.toolResultBudget!.maxTotalBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  test('budgets ONLY the read tool so write/ls stay unaffected when the budget exhausts', () => {
    const sub = createDreamingSubagent()
    expect([...sub.toolResultBudget!.toolNames]).toEqual(['read'])
  })

  test('teaches the dreaming session to cite fragments by id, not by line range', () => {
    const sub = createDreamingSubagent()
    expect(sub.systemPrompt).toContain('streams/yyyy-MM-dd#<fragment-id>')
    expect(sub.systemPrompt).toContain('cites its source fragments by id')
    expect(sub.systemPrompt).not.toContain('streams/yyyy-MM-dd:<line>-<line>')
    expect(sub.systemPrompt).not.toContain('streams/yyyy-MM-dd:<fragment line range>')
  })

  test('teaches the sharded topic layout and topic delete workflow', () => {
    const prompt = createDreamingSubagent().systemPrompt
    expect(prompt).toContain('memory/topics/')
    expect(prompt).toContain('delete_topic_shard')
    expect(prompt).toContain('one topic, one file')
    expect(prompt).toContain('YAML frontmatter plus body')
    expect(prompt).not.toContain('MEMORY.md')
    expect(prompt).not.toContain('Historical observations')
    expect(prompt).not.toContain('historical-observations')
    expect(prompt).not.toContain('write the full new contents')
  })

  test('teaches the dreaming session about muscle memory in the system prompt', () => {
    const sub = createDreamingSubagent()
    expect(sub.systemPrompt).toContain('Muscle memory')
    expect(sub.systemPrompt).toContain('memory/skills/<name>/SKILL.md')
    expect(sub.systemPrompt).toMatch(/name:\s*<name>/)
    expect(sub.systemPrompt).toMatch(/description:\s+/)
    expect(sub.systemPrompt).toContain('source: muscle-memory')
  })

  test('teaches the dreaming session that muscle memory has three forms (skill, CLI, plugin)', () => {
    const sub = createDreamingSubagent()
    // Three forms named explicitly so the model picks the smallest fit.
    expect(sub.systemPrompt).toMatch(/Form A.*skill/i)
    expect(sub.systemPrompt).toMatch(/Form B.*CLI/i)
    expect(sub.systemPrompt).toMatch(/Form C.*plugin/i)
    // Suggestion target lives under packages/ — wired to typeclaw-monorepo.
    expect(sub.systemPrompt).toContain('packages/<name>')
    // `proposal:` line is the wire format the main agent reads on every prompt.
    expect(sub.systemPrompt).toContain('proposal: cli packages/<name>')
    expect(sub.systemPrompt).toContain('proposal: plugin packages/<name>')
    // Sandbox boundary must stay explicit so the model does not try to write
    // under packages/ itself (its tools have no policy enforcement).
    expect(sub.systemPrompt).toMatch(/cannot write under .*packages\//)
  })

  test('teaches reference citations are promoted by slug and reference content stays verbatim', () => {
    const prompt = createDreamingSubagent().systemPrompt
    expect(prompt).toContain('References are verbatim artifacts')
    expect(prompt).toContain('references:')
    expect(prompt).toContain('- <reference-slug>')
    expect(prompt).toContain('MUST NOT read, rewrite, or distill their content')
  })
})

describe('dreaming subagent (compaction wiring)', () => {
  test('after a successful run, the touched daily stream is compacted using topic shard citations', async () => {
    // Three fragments and three watermarks (two redundant) on the same day.
    await writeFile(
      streamFile('2026-04-27'),
      [
        fragmentLine('keep-me'),
        watermarkLine('keep-me'),
        fragmentLine('drop-me'),
        watermarkLine('drop-me'),
        fragmentLine('also-keep-me'),
        watermarkLine('also-keep-me'),
      ].join(''),
    )

    // Stub runSession to simulate what the LLM does: write a topic shard citing
    // two of the three fragments by id. The third (`f-drop-me`) is dreamed-but-uncited.
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'kept-topic',
        shardText(
          'kept topic',
          [
            'Conclusion.',
            '',
            'fragments:',
            '- streams/2026-04-27#f-keep-me',
            '- streams/2026-04-27#f-also-keep-me',
          ].join('\n'),
        ),
      )
    }

    await invokeDreaming(agentDir, { runSession })

    const raw = await readFile(streamFile('2026-04-27'), 'utf8')
    const lines = raw.trim().split('\n')
    const events = lines.map((l) => JSON.parse(l) as { type: string; id: string; source?: string; entry?: string })

    // Two surviving fragments (cited) + one surviving watermark (latest for ses_test).
    const fragmentIds = events
      .filter((e) => e.type === 'fragment')
      .map((e) => e.id)
      .sort()
    expect(fragmentIds).toEqual(['f-also-keep-me', 'f-keep-me'])
    const watermarks = events.filter((e) => e.type === 'watermark')
    expect(watermarks).toHaveLength(1)
    expect(watermarks[0]).toMatchObject({ id: 'w-also-keep-me', entry: 'also-keep-me' })
  })

  test('does NOT drop fragments when MEMORY.md was not rewritten this run (the runSession no-op case must not eat memory)', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('a'), watermarkLine('a'), watermarkLine('b')].join(''))
    // runSession is a no-op stub: the LLM decided nothing met the bar this run
    // and exited without touching MEMORY.md. dreamedIds gets advanced to include
    // f-a, but f-a must survive because the subagent never had a chance to
    // promote it into a citation.

    await invokeDreaming(agentDir)

    const raw = await readFile(streamFile('2026-04-27'), 'utf8')
    const events = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string })

    const fragmentIds = events
      .filter((e) => e.type === 'fragment')
      .map((e) => e.id)
      .sort()
    const watermarkIds = events
      .filter((e) => e.type === 'watermark')
      .map((e) => e.id)
      .sort()

    expect(fragmentIds).toEqual(['f-a'])
    expect(watermarkIds).toEqual(['w-b'])
  })

  test('DOES drop dreamed-but-uncited fragments when MEMORY.md WAS rewritten this run', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('cited'), fragmentLine('uncited')].join(''))
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'kept',
        shardText('kept', ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-cited'].join('\n')),
      )
    }

    await invokeDreaming(agentDir, { runSession })

    const raw = await readFile(streamFile('2026-04-27'), 'utf8')
    const fragmentIds = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string })
      .filter((e) => e.type === 'fragment')
      .map((e) => e.id)
    expect(fragmentIds).toEqual(['f-cited'])
  })

  test('reverts topic shards when the subagent drops a previously-cited fragment id', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('keep'), fragmentLine('also')].join(''))
    const beforeA = shardText('A', ['A.', '', 'fragments:', '- streams/2026-04-27#f-keep'].join('\n'), {
      cites: 1,
      days: 1,
      lastReinforced: '2026-04-27',
    })
    const beforeB = shardText('B', ['B.', '', 'fragments:', '- streams/2026-04-27#f-also'].join('\n'), {
      cites: 1,
      days: 1,
      lastReinforced: '2026-04-27',
    })
    await writeTopicShard('a', beforeA)
    await writeTopicShard('b', beforeB)

    // The subagent rewrites shards but forgets to carry f-also forward.
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'c',
        shardText('Half topic', ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-keep'].join('\n')),
      )
      await rm(topicShard('b'))
    }

    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, { runSession, logger })

    expect(await readFile(topicShard('a'), 'utf8')).toBe(beforeA)
    expect(await readFile(topicShard('b'), 'utf8')).toBe(beforeB)
    await expect(readFile(topicShard('c'), 'utf8')).rejects.toThrow()
    expect(warnings.some((m) => m.includes('citation-superset violation') && m.includes('f-also'))).toBe(true)
  })

  test('on a superset violation, dreamed-ids still advance (no infinite loop) but compaction does not GC fragments', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('keep'), fragmentLine('also')].join(''))
    await writeTopicShard(
      'both',
      shardText(
        'Both cited',
        ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-keep', '- streams/2026-04-27#f-also'].join('\n'),
        { cites: 2, days: 1, lastReinforced: '2026-04-27' },
      ),
    )
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'only-one',
        shardText('Only one', ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-keep'].join('\n')),
      )
      await rm(topicShard('both'))
    }
    let committed = false

    await invokeDreaming(agentDir, {
      runSession,
      commitMemory: async () => {
        committed = true
      },
    })

    const state = await loadDreamingState(agentDir)
    expect(new Set(state.dreamedThrough['2026-04-27']?.dreamedIds ?? [])).toEqual(new Set(['f-keep', 'f-also']))

    const raw = await readFile(streamFile('2026-04-27'), 'utf8')
    const fragmentIds = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id: string })
      .filter((e) => e.type === 'fragment')
      .map((e) => e.id)
      .sort()
    expect(fragmentIds).toEqual(['f-also', 'f-keep'])
    expect(committed).toBe(false)
  })

  test('does NOT revert when the subagent legitimately merges shards with the same citation set', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('a'), fragmentLine('b')].join(''))
    await writeTopicShard('a', shardText('Topic A', ['A.', '', 'fragments:', '- streams/2026-04-27#f-a'].join('\n')))
    await writeTopicShard('b', shardText('Topic B', ['B.', '', 'fragments:', '- streams/2026-04-27#f-b'].join('\n')))
    const mergedBody = ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-a', '- streams/2026-04-27#f-b'].join(
      '\n',
    )
    const mergedText = shardText('Merged', mergedBody, { cites: 2, days: 1, lastReinforced: '2026-04-27' })
    const runSession: RunSession = async () => {
      await writeTopicShard('c', shardText('Merged', mergedBody))
      await rm(topicShard('a'))
      await rm(topicShard('b'))
    }

    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, { runSession, logger })

    expect(await readFile(topicShard('c'), 'utf8')).toBe(mergedText)
    await expect(readFile(topicShard('a'), 'utf8')).rejects.toThrow()
    await expect(readFile(topicShard('b'), 'utf8')).rejects.toThrow()
    expect(warnings.some((m) => m.includes('citation-superset'))).toBe(false)
  })

  test('on revert-write failure, refuses to advance dreamed-ids or run compaction (leaves recovery to the operator)', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('only'))
    await writeTopicShard(
      'cited',
      shardText('Cited', ['C.', '', 'fragments:', '- streams/2026-04-27#f-already-cited'].join('\n')),
    )
    // The subagent drops the previously-cited id (forcing a superset
    // violation), AND makes the overwritten shard read-only so the restore
    // write cannot succeed. Both conditions together exercise the
    // revert-failure recovery path.
    const runSession: RunSession = async () => {
      await writeTopicShard('cited', shardText('New', 'No citations.'))
      await chmod(topicShard('cited'), 0o444)
    }

    const errors: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: () => {}, error: (m) => errors.push(m) }
    let committed = false

    await invokeDreaming(agentDir, {
      runSession,
      logger,
      commitMemory: async () => {
        committed = true
      },
    })

    expect(errors.some((m) => m.includes('citation-superset violation AND revert failed'))).toBe(true)
    expect(errors.some((m) => m.includes('git checkout -- memory/topics'))).toBe(true)
    // Dreamed-ids must NOT have advanced — next run gets a second chance.
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']).toBeUndefined()
    // commit must not have run on a known-bad on-disk state.
    expect(committed).toBe(false)
    await chmod(topicShard('cited'), 0o644)
  })

  test('on a successful revert, the warning explicitly names the new-fragment-orphaning tradeoff so operators can read the log', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('new')].join(''))
    await writeTopicShard(
      'old',
      shardText('Old', ['C.', '', 'fragments:', '- streams/2026-04-26#f-old-cite'].join('\n')),
    )
    const runSession: RunSession = async () => {
      await writeTopicShard('old', shardText('Dropped old citation', 'C.'))
    }

    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, { runSession, logger })

    const violation = warnings.find((m) => m.includes('citation-superset violation'))
    expect(violation).toBeDefined()
    expect(violation).toContain('orphaned')
  })

  test('does NOT trigger the safety net on first-ever run (empty prior MEMORY.md is the empty citation set)', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('first'))
    const newText = shardText(
      'First topic ever',
      ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-first'].join('\n'),
      { cites: 1, days: 1, lastReinforced: '2026-04-27' },
    )
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'first',
        shardText('First topic ever', ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-first'].join('\n')),
      )
    }

    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, { runSession, logger })

    expect(await readFile(topicShard('first'), 'utf8')).toBe(newText)
    expect(warnings.some((m) => m.includes('citation-superset'))).toBe(false)
  })

  test('promotes fragment reference slugs into the resulting topic shard body', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLineWithReferences('with-ref', ['ref-a']))
    await writeReference('ref-a', 'verbatim reference bytes\n')
    const body = [
      'Conclusion.',
      '',
      'fragments:',
      '- streams/2026-04-27#f-with-ref',
      '',
      'references:',
      '- ref-a',
    ].join('\n')
    const runSession: RunSession = async () => {
      await writeTopicShard('with-ref', shardText('With ref', body))
    }

    await invokeDreaming(agentDir, { runSession })

    const topic = await readFile(topicShard('with-ref'), 'utf8')
    expect(topic).toContain('references:\n- ref-a')
  })

  test('leaves reference file bytes unchanged after a normal dreaming run', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLineWithReferences('with-ref', ['ref-a']))
    await writeReference('ref-a', 'verbatim reference bytes\n')
    const before = await fileSha256(referenceFile('ref-a'))
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'with-ref',
        shardText(
          'With ref',
          ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-with-ref', '', 'references:', '- ref-a'].join('\n'),
        ),
      )
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await fileSha256(referenceFile('ref-a'))).toBe(before)
  })

  test('restores reference bytes and skips commit if a dreaming run rewrites them', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLineWithReferences('with-ref', ['ref-a']))
    await writeReference('ref-a', 'verbatim reference bytes\n')
    const warnings: string[] = []
    let committed = false
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }
    const runSession: RunSession = async () => {
      await writeFile(referenceFile('ref-a'), 'mutated reference bytes\n')
    }

    await invokeDreaming(agentDir, {
      runSession,
      logger,
      commitMemory: async () => {
        committed = true
      },
    })

    expect(await readFile(referenceFile('ref-a'), 'utf8')).toBe('verbatim reference bytes\n')
    expect(committed).toBe(false)
    expect(warnings).toContain(
      '[dreaming] reference content modified: ref-a — restored original bytes and aborted the dreaming commit to preserve the verbatim invariant',
    )
  })

  test('demotes stale episode references before deleting them and removes chunks from reference passages', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference('stale-ref', referenceText({ created: isoDaysAgo(40), lastAccessed: isoDaysAgo(40) }))

    await invokeDreaming(agentDir)

    const raw = await readFile(referenceFile('stale-ref'), 'utf8')
    expect(parseReference(raw).frontmatter.demoted).toBe(true)
    expect(await referencePassages(agentDir)).toEqual([])
  })

  test('demotion prunes the reference vector rows so a demoted reference is not vector-retrievable', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference('stale-ref', referenceText({ created: isoDaysAgo(40), lastAccessed: isoDaysAgo(40) }))
    // The on-write hook indexes a reference while it is demoted:false; seed that row.
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('reference:stale-ref#0', 'reference', 'stale-ref', vector({ 0: 1 }), 'stale-hash'))
    store.close()

    await invokeDreaming(agentDir)

    expect(parseReference(await readFile(referenceFile('stale-ref'), 'utf8')).frontmatter.demoted).toBe(true)
    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(afterStore.getByIds(['reference:stale-ref#0'])).toEqual([])
    } finally {
      afterStore.close()
    }
  })

  test('deletes demoted references only after the extended dormancy window', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('first'))
    await writeReference('stale-ref', referenceText({ created: isoDaysAgo(40), lastAccessed: isoDaysAgo(40) }))

    await invokeDreaming(agentDir)
    expect(parseReference(await readFile(referenceFile('stale-ref'), 'utf8')).frontmatter.demoted).toBe(true)

    await writeFile(streamFile('2026-04-28'), fragmentLine('second'))
    await invokeDreaming(agentDir)

    await expect(readFile(referenceFile('stale-ref'), 'utf8')).rejects.toThrow()
  })

  test('exempts pinned, curated, and external references from automatic decay', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference(
      'pinned-ref',
      referenceText({ created: isoDaysAgo(90), lastAccessed: isoDaysAgo(90), pinned: true }),
    )
    await writeReference(
      'curated-ref',
      referenceText({ created: isoDaysAgo(90), lastAccessed: isoDaysAgo(90), origin: 'curated' }),
    )
    await writeReference(
      'external-ref',
      referenceText({ created: isoDaysAgo(90), lastAccessed: isoDaysAgo(90), origin: 'external' }),
    )

    await invokeDreaming(agentDir)

    expect(parseReference(await readFile(referenceFile('pinned-ref'), 'utf8')).frontmatter.demoted).toBe(false)
    expect(parseReference(await readFile(referenceFile('curated-ref'), 'utf8')).frontmatter.demoted).toBe(false)
    expect(parseReference(await readFile(referenceFile('external-ref'), 'utf8')).frontmatter.demoted).toBe(false)
  })

  test('recent access keeps an old episode reference above the decay threshold', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference(
      'recent-ref',
      referenceText({ created: isoDaysAgo(90), lastAccessed: new Date().toISOString() }),
    )

    await invokeDreaming(agentDir)

    expect(parseReference(await readFile(referenceFile('recent-ref'), 'utf8')).frontmatter.demoted).toBe(false)
  })

  test('eviction removes reference files, vectors, and upward topic citations', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference(
      'ref-x',
      referenceText({ created: isoDaysAgo(60), lastAccessed: isoDaysAgo(60), demoted: true }),
    )
    await writeTopicShard(
      'with-ref',
      shardText(
        'With ref',
        ['Conclusion.', '', 'references:', '- ref-x', '', 'fragments:', '- streams/2026-04-27#f-tick'].join('\n'),
      ),
    )
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('reference:ref-x#0', 'reference', 'ref-x', vector({ 0: 1 }), 'ref-hash'))
    store.close()

    await invokeDreaming(agentDir)

    await expect(readFile(referenceFile('ref-x'), 'utf8')).rejects.toThrow()
    const topic = await readFile(topicShard('with-ref'), 'utf8')
    expect(topic).not.toContain('ref-x')
    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(afterStore.getByIds(['reference:ref-x#0'])).toEqual([])
    } finally {
      afterStore.close()
    }
  })

  test('includes reference demotion and eviction counts in the done metrics line', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('tick'))
    await writeReference('demote-me', referenceText({ created: isoDaysAgo(40), lastAccessed: isoDaysAgo(40) }))
    await writeReference(
      'evict-me',
      referenceText({ created: isoDaysAgo(60), lastAccessed: isoDaysAgo(60), demoted: true }),
    )
    const infos: string[] = []
    const logger: DreamingLogger = { info: (m) => infos.push(m), warn: () => {}, error: () => {} }

    await invokeDreaming(agentDir, { logger })

    const done = infos.find((m) => m.startsWith('[dreaming] done'))
    expect(done).toContain('references_demoted=1')
    expect(done).toContain('references_evicted=1')
  })

  test('revert preserves byte-identical shard content for unchanged shards and deletes net-new shards', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('keep'), fragmentLine('drop')].join(''))
    const stable = shardText('Stable', ['Stable.', '', 'fragments:', '- streams/2026-04-27#f-keep'].join('\n'), {
      cites: 1,
      days: 1,
      lastReinforced: '2026-04-27',
      tags: ['keep'],
    })
    const dropped = shardText('Dropped', ['Dropped.', '', 'fragments:', '- streams/2026-04-27#f-drop'].join('\n'), {
      cites: 1,
      days: 1,
      lastReinforced: '2026-04-27',
    })
    await writeTopicShard('stable', stable)
    await writeTopicShard('dropped', dropped)
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'new',
        shardText('New', ['New.', '', 'fragments:', '- streams/2026-04-27#f-keep'].join('\n')),
      )
      await rm(topicShard('dropped'))
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('stable'), 'utf8')).toBe(stable)
    expect(await readFile(topicShard('dropped'), 'utf8')).toBe(dropped)
    await expect(readFile(topicShard('new'), 'utf8')).rejects.toThrow()
  })

  test('emits a [dreaming] compaction log line when files are rewritten', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('f1'), watermarkLine('w1'), watermarkLine('w2')].join(''))
    const infos: string[] = []
    const logger: DreamingLogger = { info: (m) => infos.push(m), warn: () => {}, error: () => {} }

    await invokeDreaming(agentDir, { logger })

    expect(infos.some((m) => m.startsWith('[dreaming] compaction') && m.includes('files=1'))).toBe(true)
  })

  test('QA 2.3: reindexes changed topic shards and deletes removed topic vectors after a successful dream', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('old'), fragmentLine('gone'), fragmentLine('new')].join(''))
    await writeTopicShard('old', shardText('Old', ['Old.', '', 'fragments:', '- streams/2026-04-27#f-old'].join('\n')))
    await writeTopicShard(
      'gone',
      shardText('Gone', ['Gone.', '', 'fragments:', '- streams/2026-04-27#f-gone'].join('\n')),
    )
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('topic:old', 'topic', 'old', vector({ 0: 1 }), 'old-hash'))
    store.upsert(vectorRow('topic:gone', 'topic', 'gone', vector({ 1: 1 }), 'gone-hash'))
    store.close()
    const embeddedTexts: string[] = []
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'old',
        shardText(
          'Old updated',
          ['Old updated.', '', 'fragments:', '- streams/2026-04-27#f-old', '- streams/2026-04-27#f-gone'].join('\n'),
        ),
      )
      await writeTopicShard(
        'new',
        shardText('New', ['New.', '', 'fragments:', '- streams/2026-04-27#f-new'].join('\n')),
      )
      await rm(topicShard('gone'))
    }

    await invokeDreaming(agentDir, { runSession, vectorEmbedFn: embedRecording(embeddedTexts) })

    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(afterStore.getByIds(['topic:gone'])).toEqual([])
      expect(
        afterStore
          .getByIds(['topic:old', 'topic:new'])
          .map((row) => row.id)
          .sort(),
      ).toEqual(['topic:new', 'topic:old'])
      // The citation lines and `fragments:` heading are stripped before embedding;
      // only the heading + belief prose reaches the embedder.
      expect(embeddedTexts).toContain('Old updated\nOld updated.')
      expect(embeddedTexts).toContain('New\nNew.')
    } finally {
      afterStore.close()
    }
  })

  test('vector sync failure is best-effort: dream still advances dreamed-ids and commits', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('f1'))
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.close()
    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }
    const runSession: RunSession = async () => {
      await writeTopicShard('t1', shardText('T1', ['T1.', '', 'fragments:', '- streams/2026-04-27#f1'].join('\n')))
    }

    await invokeDreaming(agentDir, {
      runSession,
      logger,
      vectorEmbedFn: async () => {
        throw new Error('model unavailable')
      },
    })

    const state = await loadDreamingState(agentDir)
    expect(getDreamedIds(state, '2026-04-27').size).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes('vector topic sync failed'))).toBe(true)
  })

  test('QA 2.4: deletes stream vectors for fragments dropped by dreaming compaction', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('cited'), fragmentLine('drop')].join(''))
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('stream:2026-04-27#f-cited', 'stream', '2026-04-27#f-cited', vector({ 0: 1 }), 'cited'))
    store.upsert(vectorRow('stream:2026-04-27#f-drop', 'stream', '2026-04-27#f-drop', vector({ 1: 1 }), 'drop'))
    store.close()
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'kept',
        shardText('Kept', ['Kept.', '', 'fragments:', '- streams/2026-04-27#f-cited'].join('\n')),
      )
    }

    await invokeDreaming(agentDir, { runSession, vectorEmbedFn: async () => [vector({ 2: 1 })] })

    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      // The cited fragment is now dreamed too, so its standalone stream row is
      // redundant (the parent topic covers it) and is pruned alongside the GC'd one.
      expect(afterStore.getByIds(['stream:2026-04-27#f-cited'])).toEqual([])
      expect(afterStore.getByIds(['stream:2026-04-27#f-drop'])).toEqual([])
    } finally {
      afterStore.close()
    }
  })

  test('a dreaming run prunes the redundant stream vector of a dreamed-and-cited fragment', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('stream:2026-04-27#f-new', 'stream', '2026-04-27#f-new', vector({ 0: 1 }), 'new'))
    store.close()
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'beliefs',
        shardText('Beliefs', ['Beliefs.', '', 'fragments:', '- streams/2026-04-27#f-new'].join('\n')),
      )
    }

    await invokeDreaming(agentDir, { runSession, vectorEmbedFn: async () => [vector({ 2: 1 })] })

    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(afterStore.getByIds(['stream:2026-04-27#f-new'])).toEqual([])
    } finally {
      afterStore.close()
    }
  })

  test('deleteRedundantDreamedCitedStreamVectors removes dreamed-and-cited rows but keeps undreamed and uncited ones', async () => {
    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    store.upsert(vectorRow('stream:2026-04-27#f-cited', 'stream', '2026-04-27#f-cited', vector({ 0: 1 }), 'cited'))
    store.upsert(vectorRow('stream:2026-04-27#f-fresh', 'stream', '2026-04-27#f-fresh', vector({ 1: 1 }), 'fresh'))
    store.upsert(vectorRow('stream:2026-04-27#f-uncited', 'stream', '2026-04-27#f-uncited', vector({ 2: 1 }), 'unc'))
    store.close()
    const dreamed = addDreamedIds(emptyState(), '2026-04-27', ['f-cited', 'f-uncited'], 'now')
    const citedByDate = new Map([['2026-04-27', new Set(['f-cited', 'f-fresh'])]])

    const pruned = deleteRedundantDreamedCitedStreamVectors(agentDir, dreamed, citedByDate)

    expect(pruned).toBe(1)
    const afterStore = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      // dreamed + cited → pruned; undreamed-but-cited (freshness window) and
      // dreamed-but-uncited (left for the GC path) both survive this helper.
      expect(afterStore.getByIds(['stream:2026-04-27#f-cited'])).toEqual([])
      expect(afterStore.getByIds(['stream:2026-04-27#f-fresh']).map((r) => r.id)).toEqual(['stream:2026-04-27#f-fresh'])
      expect(afterStore.getByIds(['stream:2026-04-27#f-uncited']).map((r) => r.id)).toEqual([
        'stream:2026-04-27#f-uncited',
      ])
    } finally {
      afterStore.close()
    }
  })

  test('QA 2.5: compactDailyStreams returns vector keys for dropped fragments', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('cited'), fragmentLine('drop')].join(''))
    const state = addDreamedIds(emptyState(), '2026-04-27', ['f-cited', 'f-drop'], 'now')
    const cited = new Map([['2026-04-27', new Set(['f-cited'])]])

    const stats = await compactDailyStreams(agentDir, state, cited, ['2026-04-27'], { applyFragmentGc: true })

    expect(stats.droppedFragmentIds).toEqual(['2026-04-27#f-drop'])
  })
})

describe('dreaming subagent (runtime-managed shard frontmatter)', () => {
  test('corrects stale citation counts, distinct days, and last reinforced date from the shard body', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const body = [
      'Conclusion.',
      '',
      'fragments:',
      '- streams/2026-04-25#f-a',
      '- streams/2026-04-26#f-b',
      '- streams/2026-04-27#f-c',
    ].join('\n')
    const runSession: RunSession = async () => {
      await writeTopicShard('counts', shardText('Counts', body, { cites: 0, days: 0, lastReinforced: '1970-01-01' }))
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('counts'), 'utf8')).toBe(
      shardText('Counts', body, { cites: 3, days: 3, lastReinforced: '2026-04-27' }),
    )
  })

  test('synthesizes frontmatter when the subagent writes a raw markdown shard body', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const rawBody = ['## Synthesized heading', '', 'Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-new'].join(
      '\n',
    )
    const runSession: RunSession = async () => {
      await writeTopicShard('synth', rawBody)
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('synth'), 'utf8')).toBe(
      shardText('Synthesized heading', rawBody, { cites: 1, days: 1, lastReinforced: '2026-04-27' }),
    )
  })

  test('leaves already-correct frontmatter byte-identical after recompute', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const body = ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-new'].join('\n')
    const exact = shardText('Exact', body, { cites: 1, days: 1, lastReinforced: '2026-04-27', tags: ['valid'] })
    const runSession: RunSession = async () => {
      await writeTopicShard('exact', exact)
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('exact'), 'utf8')).toBe(exact)
  })

  test('keeps the prior last reinforced date for a shard with no dated citations', async () => {
    // given
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const body = ['Old conclusion.', '', 'fragments:', '- memory/2026-04-01:1-10'].join('\n')
    const stale = shardText('Stale', body, { cites: 0, days: 0, lastReinforced: '2026-04-01' })
    const runSession: RunSession = async () => {
      await writeTopicShard('stale', stale)
    }

    // when
    await invokeDreaming(agentDir, { runSession })

    // then
    expect(await readFile(topicShard('stale'), 'utf8')).toBe(stale)
  })

  test('drops malformed tags with a warning while preserving other runtime-managed fields', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const raw = [
      '---',
      'heading: Bad tags',
      'cites: 0',
      'days: 0',
      'lastReinforced: 1970-01-01',
      'tags: a-string',
      '---',
      'Conclusion.',
      '',
      'fragments:',
      '- streams/2026-04-27#f-new',
    ].join('\n')
    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }
    const runSession: RunSession = async () => {
      await writeTopicShard('bad-tags', raw)
    }

    await invokeDreaming(agentDir, { runSession, logger })

    expect(await readFile(topicShard('bad-tags'), 'utf8')).toBe(
      shardText('Bad tags', ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-new'].join('\n'), {
        cites: 1,
        days: 1,
        lastReinforced: '2026-04-27',
      }),
    )
    expect(warnings.some((m) => m.includes('dropping malformed tags'))).toBe(true)
  })

  test('preserves well-formed tags when recomputing runtime-managed fields', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))
    const body = ['Conclusion.', '', 'fragments:', '- streams/2026-04-27#f-new'].join('\n')
    const runSession: RunSession = async () => {
      await writeTopicShard('tags', shardText('Tags', body, { tags: ['valid', 'arr'] }))
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('tags'), 'utf8')).toBe(
      shardText('Tags', body, { cites: 1, days: 1, lastReinforced: '2026-04-27', tags: ['valid', 'arr'] }),
    )
  })

  test('skips frontmatter recompute on citation-superset failure after restoring the pre-run snapshot', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('keep'), fragmentLine('drop')].join(''))
    const before = shardText('Before', ['Before.', '', 'fragments:', '- streams/2026-04-27#f-drop'].join('\n'), {
      cites: 0,
      days: 0,
      lastReinforced: '1970-01-01',
    })
    await writeTopicShard('before', before)
    const runSession: RunSession = async () => {
      await writeTopicShard(
        'before',
        shardText('Before', 'No citations.', { cites: 99, days: 99, lastReinforced: '2026-04-27' }),
      )
    }

    await invokeDreaming(agentDir, { runSession })

    expect(await readFile(topicShard('before'), 'utf8')).toBe(before)
  })
})

describe('dreaming subagent (orchestration)', () => {
  test('skips dreaming entirely when no daily streams exist', async () => {
    let committed = false
    const { prompts } = await invokeDreaming(agentDir, {
      commitMemory: async () => {
        committed = true
      },
    })

    expect(prompts).toHaveLength(0)
    expect(committed).toBe(false)
  })

  test('skips dreaming when every fragment id is already in the dreamed-id set', async () => {
    await writeFile(
      streamFile('2026-04-27'),
      [fragmentLine('frag1'), fragmentLine('frag2'), fragmentLine('frag3')].join(''),
    )
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({
        version: 2,
        dreamedThrough: { '2026-04-27': { dreamedIds: ['f-frag1', 'f-frag2', 'f-frag3'], ts: 'past' } },
      }),
    )

    const { prompts } = await invokeDreaming(agentDir)
    expect(prompts).toHaveLength(0)
  })

  test('prompts subagent only with fragment ids not yet in the dreamed-id set', async () => {
    await writeFile(
      streamFile('2026-04-27'),
      [fragmentLine('a'), fragmentLine('b'), fragmentLine('c'), fragmentLine('d'), fragmentLine('e')].join(''),
    )
    await writeFile(
      join(agentDir, DREAMING_STATE_FILE),
      JSON.stringify({ version: 2, dreamedThrough: { '2026-04-27': { dreamedIds: ['f-a', 'f-b'], ts: 'past' } } }),
    )

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('memory/streams/2026-04-27.jsonl')
    expect(prompts[0]).toContain('f-c')
    expect(prompts[0]).toContain('f-d')
    expect(prompts[0]).toContain('f-e')
    expect(prompts[0]).not.toContain('f-a')
    expect(prompts[0]).not.toContain('f-b')
  })

  test('falls back to legacy flat daily streams when memory/streams does not exist', async () => {
    await rm(join(agentDir, 'memory', 'streams'), { recursive: true, force: true })
    await writeFile(legacyStreamFile('2026-04-27'), fragmentLine('legacy'))

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('memory/2026-04-27.jsonl')
    expect(prompts[0]).toContain('f-legacy')
  })

  test('teaches the subagent to cite by id in the per-run prompt, not by line number', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('one'))

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts[0]).toContain('streams/yyyy-MM-dd#<id>')
    expect(prompts[0]).not.toMatch(/offset=\d+/)
    expect(prompts[0]).not.toMatch(/total file lines/)
  })

  test('omits the strength-signals block entirely when no topic shards exist', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('only'))

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts[0]).not.toContain('topic strengths')
    expect(prompts[0]).not.toContain('| slug | heading | cites |')
  })

  test('injects a per-topic strength table sourced from topic shard frontmatter', async () => {
    await mkdir(join(agentDir, 'memory', 'topics'), { recursive: true })
    await writeFile(
      join(agentDir, 'memory', 'topics', 'strong-topic.md'),
      renderShard(
        { heading: 'Strong topic', cites: 3, days: 3, lastReinforced: '2026-04-27' },
        ['Conclusion.', '', 'fragments:', '- streams/2026-04-25#f-cite1'].join('\n'),
      ),
    )
    await writeFile(
      join(agentDir, 'memory', 'topics', 'weak-topic.md'),
      renderShard(
        { heading: 'Weak topic', cites: 1, days: 1, lastReinforced: '2026-04-20' },
        ['Conclusion.', '', 'fragments:', '- streams/2026-04-20#f-old'].join('\n'),
      ),
    )
    await writeFile(streamFile('2026-04-27'), fragmentLine('new'))

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts[0]).toContain('| slug | heading | cites | days | last reinforced | age (d) |')
    expect(prompts[0]).toMatch(/\| strong-topic \| Strong topic \| 3 \| 3 \| 2026-04-27 \|/)
    expect(prompts[0]).toMatch(/\| weak-topic \| Weak topic \| 1 \| 1 \| 2026-04-20 \|/)
    expect(prompts[0]).toContain('Existing topic shard strengths')
  })

  test('adds every undreamed fragment id to the dreamed-id set after a successful run', async () => {
    await writeFile(
      streamFile('2026-04-27'),
      [fragmentLine('a'), fragmentLine('b'), fragmentLine('c'), fragmentLine('d')].join(''),
    )

    await invokeDreaming(agentDir)

    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']?.dreamedIds).toEqual(['f-a', 'f-b', 'f-c', 'f-d'])
  })

  test('passes multiple undreamed days oldest-first to the subagent', async () => {
    await writeFile(streamFile('2026-04-25'), fragmentLine('older'))
    await writeFile(streamFile('2026-04-27'), fragmentLine('newer'))

    const { prompts } = await invokeDreaming(agentDir)

    const prompt = prompts[0] ?? ''
    expect(prompt.indexOf('2026-04-25.jsonl')).toBeGreaterThan(-1)
    expect(prompt.indexOf('2026-04-25.jsonl')).toBeLessThan(prompt.indexOf('2026-04-27.jsonl'))
  })

  test('calls commitMemory after the subagent finishes', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('only'))
    const commits: string[] = []

    await invokeDreaming(agentDir, {
      commitMemory: async (cwd) => {
        commits.push(cwd)
      },
    })

    expect(commits).toEqual([agentDir])
  })

  test('does NOT advance the dreamed-id set when prompt() throws', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('oops'))

    await expect(invokeDreaming(agentDir, { throwOnRunSession: true })).rejects.toThrow(/LLM blew up/)
    const state = await loadDreamingState(agentDir)
    expect(state.dreamedThrough['2026-04-27']).toBeUndefined()
  })

  test('skips when no fragment events are undreamed (a stream containing only watermarks does not trigger a run)', async () => {
    await writeFile(streamFile('2026-04-27'), watermarkLine('w1'))

    const { prompts } = await invokeDreaming(agentDir)
    expect(prompts).toHaveLength(0)
  })

  test('writes the dreaming state file under memory/.dreaming-state.json', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('only'))

    await invokeDreaming(agentDir)

    const raw = await readFile(join(agentDir, DREAMING_STATE_FILE), 'utf8')
    expect(raw).toContain('2026-04-27')
    expect(raw).toContain('f-only')
  })

  test('does not create root MEMORY.md on first dreaming run', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('one'))

    await invokeDreaming(agentDir)

    await expect(readFile(join(agentDir, 'MEMORY.md'), 'utf8')).rejects.toThrow()
  })

  test('emits [dreaming] start, dreamed-ids-advanced, and done log lines on a successful run', async () => {
    await writeFile(streamFile('2026-04-27'), [fragmentLine('a'), fragmentLine('b'), fragmentLine('c')].join(''))
    const infos: string[] = []
    const logger: DreamingLogger = { info: (m) => infos.push(m), warn: () => {}, error: () => {} }

    await invokeDreaming(agentDir, { commitMemory: async () => {}, logger })

    expect(
      infos.some(
        (m) => m.startsWith('[dreaming] start') && m.includes('days=1') && m.includes('undreamed_fragments=3'),
      ),
    ).toBe(true)
    expect(infos.some((m) => m.startsWith('[dreaming] dreamed-ids advanced'))).toBe(true)
    expect(infos.some((m) => m.startsWith('[dreaming] done'))).toBe(true)
  })

  test('emits a [dreaming] commit-failed warning when commitMemory throws but does not rethrow', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('frag'))
    const warnings: string[] = []
    const logger: DreamingLogger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {} }

    await invokeDreaming(agentDir, {
      logger,
      commitMemory: async () => {
        throw new Error('git is angry')
      },
    })

    expect(warnings.some((m) => m.startsWith('[dreaming] commit failed') && m.includes('git is angry'))).toBe(true)
  })

  test('emits a [dreaming] run-threw warning and rethrows when runSession fails', async () => {
    await writeFile(streamFile('2026-04-27'), fragmentLine('frag'))
    const warnings: string[] = []
    const logger: DreamingLogger = { info: (m) => void m, warn: (m) => warnings.push(m), error: () => {} }

    await expect(invokeDreaming(agentDir, { throwOnRunSession: true, logger })).rejects.toThrow(/LLM blew up/)
    expect(warnings.some((m) => m.startsWith('[dreaming] run threw') && m.includes('LLM blew up'))).toBe(true)
  })
})

function vectorRow(
  id: string,
  source: 'topic' | 'stream' | 'reference',
  key: string,
  embedding: Float32Array,
  contentHash: string,
): Omit<VectorRow, 'updatedAt'> {
  return { id, source, key, model: EMBEDDING_MODEL_ID, dims: embedding.length, embedding, contentHash }
}

function embedRecording(texts: string[]): EmbedFn {
  return async (input, type) => {
    expect(type).toBe('passage')
    texts.push(...input)
    return input.map((_, index) => vector({ [index]: 1 }))
  }
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const gitArgs = existsSync(join(cwd, '.gitstore')) ? ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd] : []
  const proc = Bun.spawn({
    cmd: ['git', ...gitArgs, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

async function initRepo(cwd: string): Promise<void> {
  await runGit(cwd, ['init', '-q', '-b', 'main'])
  await writeFile(join(cwd, '.gitignore'), 'memory/\n')
  await runGit(cwd, ['add', '.gitignore'])
  await runGit(cwd, ['commit', '-qm', 'init'])
}

async function relocateGitStore(cwd: string): Promise<void> {
  await rename(join(cwd, '.git'), join(cwd, '.gitstore'))
}

async function trackedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['ls-files', '--', 'memory/'])
  return result.stdout.length === 0 ? [] : result.stdout.split('\n').sort()
}

async function porcelainStatus(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['status', '--porcelain', '--', 'memory/'])
  return result.stdout
}

async function skipWorktreeFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ['ls-files', '-v', '--', 'memory/'])
  if (result.stdout.length === 0) return []
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('S '))
    .map((line) => line.slice(2))
    .sort()
}

describe('commitMemorySnapshot', () => {
  test('commits a snapshot without executing a planted hook', async () => {
    await initRepo(agentDir)
    await writeFile(streamFile('2026-04-27'), 'fragment\n')
    const marker = join(agentDir, 'hook-ran')
    const hook = join(agentDir, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, `#!/bin/sh\nprintf hook > "${marker}"\n`)
    await chmod(hook, 0o755)

    await commitMemorySnapshot(agentDir)

    expect(await Bun.file(marker).exists()).toBe(false)
    expect((await runGit(agentDir, ['log', '-1', '--format=%s'])).stdout).toStartWith('dream:')
  })

  test('is a no-op when the directory is not a git repo', async () => {
    await writeFile(streamFile('2026-04-27'), 'fragment\n')
    await commitMemorySnapshot(agentDir)
    expect(await trackedFiles(agentDir)).toEqual([])
  })

  test('first run: force-adds memory artifacts, commits, and sets skip-worktree on tracked files', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), 'fragment\n')

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['memory/streams/2026-04-27.jsonl'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['memory/streams/2026-04-27.jsonl'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('force-adds ignored memory artifacts but excludes the rebuildable vector cache', async () => {
    await initRepo(agentDir)
    await writeFile(streamFile('2026-04-27'), 'fragment\n')
    const vectorDir = join(agentDir, 'memory', '.vectors')
    await mkdir(vectorDir, { recursive: true })
    await writeFile(join(vectorDir, 'index.db'), 'sqlite cache')
    await writeFile(join(vectorDir, 'index.db-wal'), 'wal sidecar')
    await writeFile(join(vectorDir, 'index.db-shm'), 'shm sidecar')

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['memory/streams/2026-04-27.jsonl'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['memory/streams/2026-04-27.jsonl'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('does not commit a snapshot when only the rebuildable vector cache exists', async () => {
    await initRepo(agentDir)
    const vectorDir = join(agentDir, 'memory', '.vectors')
    await mkdir(vectorDir, { recursive: true })
    await writeFile(join(vectorDir, 'index.db'), 'sqlite cache')
    await writeFile(join(vectorDir, 'index.db-wal'), 'wal sidecar')
    await writeFile(join(vectorDir, 'index.db-shm'), 'shm sidecar')

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual([])
    expect(await lastCommitSubject(agentDir)).toBe('init')
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('subsequent edits to tracked memory files do not appear in git status', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), 'first\n')
    await commitMemorySnapshot(agentDir)

    await writeFile(streamFile('2026-04-27'), 'first\nsecond\n')
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory v2\n')

    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('captures muscle-memory skills under memory/skills/<name>/SKILL.md (recursively under memory/)', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await mkdir(join(agentDir, 'memory', 'skills', 'release-checklist'), { recursive: true })
    await writeFile(
      join(agentDir, 'memory', 'skills', 'release-checklist', 'SKILL.md'),
      '---\nname: release-checklist\n---\n# Release\n',
    )

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['memory/skills/release-checklist/SKILL.md'])
    expect(await skipWorktreeFiles(agentDir)).toEqual(['memory/skills/release-checklist/SKILL.md'])
    expect(await porcelainStatus(agentDir)).toBe('')
  })

  test('commits Korean memory artifacts through a relocated gitstore', async () => {
    await initRepo(agentDir)
    await relocateGitStore(agentDir)
    await writeFile(streamFile('2026-04-27'), fragmentLine('korean', '사용자 선호', '사용자는 한국어 메모를 남겼다'))

    await commitMemorySnapshot(agentDir)

    expect(await trackedFiles(agentDir)).toEqual(['memory/streams/2026-04-27.jsonl'])
    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 1 fragment /)
    expect(await porcelainStatus(agentDir)).toBe('')
  })
})

async function lastCommitSubject(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['log', '-1', '--format=%s'])
  return result.stdout
}

describe('dream commit message', () => {
  test('starts with `dream:` and ends with a single emoji from the pool', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), fragmentLine('one'))

    await commitMemorySnapshot(agentDir)

    const subject = await lastCommitSubject(agentDir)
    expect(subject.startsWith('dream: ')).toBe(true)
    const last = [...subject].at(-1) ?? ''
    expect(DREAM_EMOJI_POOL).toContain(last as (typeof DREAM_EMOJI_POOL)[number])
  })

  test('reports `N fragments` derived from fragment events in memory/yyyy-MM-dd.jsonl', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(
      streamFile('2026-04-27'),
      [fragmentLine('a'), fragmentLine('b'), fragmentLine('c'), fragmentLine('d'), fragmentLine('e')].join(''),
    )

    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 5 fragments /)
  })

  test('counts fragment events only in the commit summary, excluding watermarks and legacy prose', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(
      streamFile('2026-04-27'),
      [fragmentLine('a'), watermarkLine('a'), fragmentLine('b'), watermarkLine('b'), legacyProseLine()].join(''),
    )

    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 2 fragments /)
  })

  test('uses singular `fragment` when exactly one line was added', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), fragmentLine('only-one'))

    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 1 fragment /)
  })

  test("appends `new skill 'x'` when a single muscle-memory skill is newly added", async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), [fragmentLine('f1'), fragmentLine('f2'), fragmentLine('f3')].join(''))
    await mkdir(join(agentDir, 'memory', 'skills', 'pr-review'), { recursive: true })
    await writeFile(join(agentDir, 'memory', 'skills', 'pr-review', 'SKILL.md'), '---\nname: pr-review\n---\n# PR\n')

    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 3 fragments \+ new skill 'pr-review' /)
  })

  test('reports `N new skills` when multiple muscle-memory skills are newly added', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), fragmentLine('frag'))
    await mkdir(join(agentDir, 'memory', 'skills', 'one'), { recursive: true })
    await mkdir(join(agentDir, 'memory', 'skills', 'two'), { recursive: true })
    await writeFile(join(agentDir, 'memory', 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\n#1\n')
    await writeFile(join(agentDir, 'memory', 'skills', 'two', 'SKILL.md'), '---\nname: two\n---\n#2\n')

    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: 1 fragment \+ 2 new skills /)
  })

  test('falls back to `watermarks only` when only untracked files change', async () => {
    await initRepo(agentDir)
    await writeFile(streamFile('2026-04-27'), fragmentLine('frag'))
    await commitMemorySnapshot(agentDir)

    await writeFile(join(agentDir, 'MEMORY.md'), '# v2\n')
    await writeFile(join(agentDir, DREAMING_STATE_FILE), '{"version":2,"dreamedThrough":{}}')
    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: watermarks only /)
  })

  test('falls back to `watermarks only` when neither MEMORY.md nor any stream has line additions', async () => {
    await initRepo(agentDir)
    await writeFile(join(agentDir, 'MEMORY.md'), '# Memory\n')
    await writeFile(streamFile('2026-04-27'), [fragmentLine('frag1'), fragmentLine('frag2')].join(''))
    await commitMemorySnapshot(agentDir)

    // Truncate the stream below its previous line count — numstat sees 0 added
    // (only deletions), and MEMORY.md is untouched. The state file is still
    // staged, which is exactly the `watermarks only` shape.
    await writeFile(streamFile('2026-04-27'), '')
    await writeFile(join(agentDir, DREAMING_STATE_FILE), '{"version":1,"dreamedThrough":{}}')
    await commitMemorySnapshot(agentDir)

    expect(await lastCommitSubject(agentDir)).toMatch(/^dream: watermarks only /)
  })
})

describe('dreaming over-budget compaction signal', () => {
  function vectorIndexPath(): string {
    return join(agentDir, 'memory', '.vectors', 'index.db')
  }

  async function createVectorIndex(): Promise<void> {
    VectorStore.open(vectorIndexPath()).close()
  }

  const overBudgetBody = `${'verbose legacy prose. '.repeat(400)}\n\nfragments:\n- streams/2026-05-16#f-seed`

  test('surfaces an over-budget shard in the dreaming prompt when the vector index exists', async () => {
    await writeFile(streamFile('2026-05-16'), fragmentLine('seed'))
    await writeTopicShard('bloated-topic', shardText('a bloated legacy topic', overBudgetBody))
    await createVectorIndex()

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Over the embedding budget')
    expect(prompts[0]).toContain('bloated-topic')
    expect(prompts[0]).toContain('preserving EVERY')
  })

  test('does NOT surface the over-budget table when the vector index is absent (vector off)', async () => {
    await writeFile(streamFile('2026-05-16'), fragmentLine('seed'))
    await writeTopicShard('bloated-topic', shardText('a bloated legacy topic', overBudgetBody))

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('Over the embedding budget')
  })

  test('does NOT surface a compact shard that fits the budget', async () => {
    await writeFile(streamFile('2026-05-16'), fragmentLine('seed'))
    await writeTopicShard(
      'compact-topic',
      shardText('the user prefers bun over npm', 'fragments:\n- streams/2026-05-16#f-seed'),
    )
    await createVectorIndex()

    const { prompts } = await invokeDreaming(agentDir)

    expect(prompts[0]).not.toContain('Over the embedding budget')
  })
})
