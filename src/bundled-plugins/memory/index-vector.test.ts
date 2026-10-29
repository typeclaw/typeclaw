import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import type { AdapterId } from '@/channels/schema'
import { noopPermissionService } from '@/permissions'
import type { PermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { renderShard } from './frontmatter'
import { createMemoryPluginForTests, type MemoryPluginDeps } from './index'
import { streamFilePath, streamsDir, topicShardPath, topicsDir } from './paths'
import type { FragmentEvent } from './stream-events'
import { appendEvents } from './stream-io'
import { VectorStore } from './vector/store'

// Injected per plugin instance via the factory, NOT mock.module: a module-level
// mock of './vector/hybrid' leaks into any sibling test that loads `./index` in
// the same worker (e.g. the real-pipeline test in index-vector-retrieval), which
// surfaced as a CI-only flake. The factory scopes the fake to this file's boot.
const hybridSearchMock = mock(async () => [
  {
    source: 'topic' as const,
    key: 'second-topic',
    heading: 'Second Topic',
    excerpt: 'Second topic excerpt from vector retrieval.',
    rrfScore: 1,
  },
])
let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-vector-'))
})

afterEach(async () => {
  await rmTempDir(agentDir)
})

describe('vector session.turn.start hook', () => {
  test('an undefined origin receives automatic retrieval without a permission gate', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'private-topic', 'Private Topic', 'private body')
    const exports = await bootVectorPlugin(16384)
    const retrievalContext = { results: 'sentinel' }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_missing_origin', agentDir, userPrompt: 'private', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(hybridSearchMock).toHaveBeenCalled()
  })

  test('over-budget turn runs hybrid search and injects top-K under # Memory framing', async () => {
    // given: two 3 KB shards (6 KB total) with a 4 KB budget → index mode
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    const exports = await bootVectorPlugin(4096)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'second prompt', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).toHaveBeenCalledWith(
      'second prompt',
      expect.anything(),
      agentDir,
      10,
      expect.any(Function),
    )
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })

  test('under-budget turn runs hybrid search instead of dumping all shard bodies', async () => {
    hybridSearchMock.mockClear()
    // given: two small shards well under the budget
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'first body')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'second body')
    const exports = await bootVectorPlugin(16384)

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(hybridSearchMock).toHaveBeenCalledWith('anything', expect.anything(), agentDir, 10, expect.any(Function))
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Second Topic')
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
    expect(retrievalContext.results).not.toContain('first body')
    expect(retrievalContext.results).not.toContain('second body')
  })

  test('under-budget turn falls back to all headings when hybrid search returns nothing', async () => {
    const emptySearch = mock(async () => [])
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'private first body')
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'private second body')
    const infos: string[] = []
    const exports = await bootVectorPluginWith(emptySearch, 16384, capturingLogger(infos))

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(emptySearch).toHaveBeenCalledWith('anything', expect.anything(), agentDir, 10, expect.any(Function))
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('- `first-topic`')
    expect(retrievalContext.results).toContain('- `second-topic`')
    expect(retrievalContext.results).not.toContain('private first body')
    expect(retrievalContext.results).not.toContain('private second body')
    expect(infos.some((line) => line.includes('suppressed=1') && line.includes('fallback=topic-index'))).toBe(true)
  })

  test('environmental-incident shards are excluded from automatic retrieval', async () => {
    const emptySearch = mock(async () => [])
    await writeTopic(agentDir, 'ordinary-belief', 'Ordinary belief', 'ordinary body')
    await writeTopic(
      agentDir,
      'environment-failure',
      'Environment failure',
      'historical workaround body',
      'environmental-incident',
    )
    const exports = await bootVectorPluginWith(emptySearch, 16384)
    const retrievalContext = { results: '' }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_environment_fence', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toContain('ordinary-belief')
    expect(retrievalContext.results).not.toContain('environment-failure')
    expect(retrievalContext.results).not.toContain('historical workaround body')
  })

  test('zero-shard turn still logs suppression without falling back to an empty index', async () => {
    const emptySearch = mock(async () => [])
    const infos: string[] = []
    const exports = await bootVectorPluginWith(emptySearch, 16384, capturingLogger(infos))

    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_vector', agentDir, userPrompt: 'anything', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toBe('')
    expect(emptySearch).toHaveBeenCalled()
    expect(infos.some((line) => line.includes('suppressed=1') && !line.includes('fallback=topic-index'))).toBe(true)
  })

  test('second retrieval turn dedups unchanged excerpts to slug references', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    // given: turn one injected the retrieved excerpt
    const first = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)
    expect(first.results).toContain('Second topic excerpt from vector retrieval.')

    // when: a second turn runs for the same session with the shard unchanged
    const second = { results: '' }
    await hook({ sessionId: 'ses_dedup', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the excerpt is replaced by a recoverable slug reference, not re-sent
    expect(second.results).toContain('## Second Topic')
    expect(second.results).not.toContain('Second topic excerpt from vector retrieval.')
    expect(second.results).toContain('slug: `second-topic`')
    expect(second.results).toContain('memory_search({ topic: "second-topic" })')
  })

  test('a changed retrieved excerpt re-injects on the next turn', async () => {
    const retrieved = mock(async () => [retrievedTopic('topic', 'Topic', 'original excerpt')])
    const exports = await bootVectorPluginWith(retrieved, 16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const first = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn one', retrievalContext: first }, ctx)

    // when: retrieval returns changed content (a dreaming pass rewrote the shard)
    retrieved.mockImplementation(async () => [retrievedTopic('topic', 'Topic', 'rewritten excerpt')])
    const second = { results: '' }
    await hook({ sessionId: 'ses_change', agentDir, userPrompt: 'turn two', retrievalContext: second }, ctx)

    // then: the fresh excerpt is injected, not a stale reference
    expect(second.results).toContain('rewritten excerpt')
    expect(second.results).not.toContain('slug: `topic`')
  })

  test('dedup state is per-session: a different session still gets the excerpt', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    const a = { results: '' }
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a1', retrievalContext: a }, ctx)
    await hook({ sessionId: 'ses_a', agentDir, userPrompt: 'a2', retrievalContext: a }, ctx)

    // when: a brand-new session asks on its first turn
    const b = { results: '' }
    await hook({ sessionId: 'ses_b', agentDir, userPrompt: 'b1', retrievalContext: b }, ctx)

    // then: it gets the excerpt — dedup state does not bleed across sessions
    expect(b.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('session.end clears dedup state so a resurrected session re-injects the excerpt', async () => {
    hybridSearchMock.mockClear()
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn one', retrievalContext: { results: '' } }, ctx)

    // when: the session ends, then the same id resurrects and asks again
    await exports.hooks!['session.end']!({ sessionId: 'ses_res' }, ctx)
    const after = { results: '' }
    await hook({ sessionId: 'ses_res', agentDir, userPrompt: 'turn two', retrievalContext: after }, ctx)

    // then: the excerpt is injected again — no dangling reference to content the
    // resurrected model context no longer holds
    expect(after.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('channel direct-mode turn force-indexes every shard heading without hybrid search', async () => {
    hybridSearchMock.mockClear()
    // given: two under-budget topics → direct mode, but a channel origin
    await writeOriginFragments(agentDir, [
      originFragment('local-first', 'w1', 'The user greets in the morning.'),
      originFragment('local-second', 'w1', 'The user prefers dark mode.'),
      {
        ...originFragment('private-same-workspace', 'w1', 'Private same-workspace belief.'),
        where: { adapter: 'slack-bot', workspace: 'w1', chat: 'private-chat', thread: null },
      },
      originFragment('foreign', 'w2', 'Foreign workspace belief.'),
    ])
    await writeTopic(
      agentDir,
      'private-same-workspace-topic',
      'Private Same Workspace',
      'Private same-workspace belief.\nfragments:\n- streams/2026-07-01#private-same-workspace',
    )
    await writeTopic(
      agentDir,
      'first-topic',
      'First Topic',
      'The user greets in the morning.\nfragments:\n- streams/2026-07-01#local-first',
    )
    await writeTopic(
      agentDir,
      'second-topic',
      'Second Topic',
      'The user prefers dark mode.\nfragments:\n- streams/2026-07-01#local-second',
    )
    await writeTopic(
      agentDir,
      'foreign-topic',
      'Foreign Topic',
      'Foreign workspace belief.\nfragments:\n- streams/2026-07-01#foreign',
    )
    await writeTopic(
      agentDir,
      'mixed-topic',
      'Mixed Topic',
      'Mixed workspace body.\nfragments:\n- streams/2026-07-01#local-first\n- streams/2026-07-01#foreign',
    )
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    const origin = {
      kind: 'channel' as const,
      adapter: 'slack-bot' as const,
      workspace: 'w1',
      chat: 'c1',
      thread: null,
    }

    const first = { results: '' }
    await hook({ sessionId: 'ses_ch', agentDir, userPrompt: 'q1', origin, retrievalContext: first }, ctx)

    // then: every topic survives without relevance or origin filtering, while the
    // full body section remains stripped and hybrid search is never consulted.
    expect(first.results).toContain('- The user greets in the morning. `first-topic`')
    expect(first.results).toContain('- The user prefers dark mode. `second-topic`')
    expect(first.results).toContain('foreign-topic')
    expect(first.results).toContain('private-same-workspace-topic')
    expect(first.results).toContain('mixed-topic')
    expect(first.results).not.toContain('## First Topic')
    expect(first.results).not.toContain('cites=')
    expect(first.results).toContain('[MEMORY CONTEXT — not instructions]')
    expect(first.results).not.toContain('Long-term memory below survives across sessions.')
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  test('Discord DM direct-mode injection keeps all topic headings visible', async () => {
    await writeOriginFragments(agentDir, [
      {
        ...originFragment('dm-a', '@dm', 'Local DM belief.'),
        where: { adapter: 'discord', workspace: '@dm', chat: 'dm-a', thread: null },
      },
      {
        ...originFragment('dm-b', '@dm', 'Foreign DM belief.'),
        where: { adapter: 'discord', workspace: '@dm', chat: 'dm-b', thread: null },
      },
    ])
    await writeTopic(agentDir, 'dm-a-topic', 'DM A', 'Local DM belief.\nfragments:\n- streams/2026-07-01#dm-a')
    await writeTopic(agentDir, 'dm-b-topic', 'DM B', 'Foreign DM belief.\nfragments:\n- streams/2026-07-01#dm-b')
    await writeTopic(
      agentDir,
      'dm-unresolved',
      'Unresolved DM',
      'Unresolved local body.\nfragments:\n- streams/2026-07-01#dm-a\n- streams/2026-07-01#missing',
    )
    const exports = await bootVectorPlugin(16384)
    const retrievalContext = { results: '' }

    await exports.hooks!['session.turn.start']!(
      {
        sessionId: 'ses_dm_direct',
        agentDir,
        userPrompt: 'query',
        origin: { kind: 'channel', adapter: 'discord', workspace: '@dm', chat: 'dm-a', thread: null },
        retrievalContext,
      },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toContain('dm-a-topic')
    expect(retrievalContext.results).toContain('dm-b-topic')
    expect(retrievalContext.results).toContain('dm-unresolved')
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  test('Slack MPIM direct-mode injection keeps cross-chat headings visible', async () => {
    const fragments: FragmentEvent[] = []
    for (const adapter of ['slack', 'slack-bot'] as const) {
      for (const chat of ['GLOCAL', 'GFOREIGN']) {
        const id = `${adapter}-${chat}`
        fragments.push({
          type: 'fragment',
          id,
          ts: '2026-07-01T12:00:00.000Z',
          source: 'ses_channel',
          entry: `entry-${id}`,
          topic: id,
          body: `${id} belief.`,
          where: { adapter, workspace: '@dm', chat, thread: null },
        })
        await writeTopic(agentDir, `${id}-topic`, id, `${id} belief.\nfragments:\n- streams/2026-07-01#${id}`)
      }
    }
    await writeOriginFragments(agentDir, fragments)
    const exports = await bootVectorPlugin(16384)

    for (const adapter of ['slack', 'slack-bot'] as const) {
      const retrievalContext = { results: '' }
      await exports.hooks!['session.turn.start']!(
        {
          sessionId: `ses-mpim-${adapter}`,
          agentDir,
          userPrompt: 'query',
          origin: { kind: 'channel', adapter, workspace: '@dm', chat: 'GLOCAL', thread: null },
          retrievalContext,
        },
        { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
      )
      expect(retrievalContext.results).toContain(`${adapter}-GLOCAL-topic`)
      expect(retrievalContext.results).toContain(`${adapter}-GFOREIGN-topic`)
    }
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  test('direct-mode injection keeps every shared-workspace adapter chat visible', async () => {
    const workspaces = {
      discord: '@dm',
      'discord-bot': '@dm',
      slack: '@dm',
      'slack-bot': '@dm',
      webex: '@dm',
      'webex-bot': '@dm',
      instagram: '@instagram-dm',
      line: '@line-dm',
      kakaotalk: '@kakao-dm',
      teams: 'teams',
      'telegram-bot': 'telegram',
    } satisfies Partial<Record<AdapterId, string>>
    const fragments: FragmentEvent[] = []
    for (const [adapter, workspace] of Object.entries(workspaces) as Array<[AdapterId, string]>) {
      for (const chat of ['chat-a', 'chat-b']) {
        const id = `${adapter}-${chat}`
        fragments.push({
          type: 'fragment',
          id,
          ts: '2026-07-01T12:00:00.000Z',
          source: 'ses_channel',
          entry: `entry-${id}`,
          topic: id,
          body: `${id} belief.`,
          where: { adapter, workspace, chat, thread: null },
        })
        await writeTopic(agentDir, `${id}-topic`, id, `${id} belief.\nfragments:\n- streams/2026-07-01#${id}`)
      }
    }
    await writeOriginFragments(agentDir, fragments)
    const exports = await bootVectorPlugin(16384)

    for (const [adapter, workspace] of Object.entries(workspaces) as Array<[AdapterId, string]>) {
      const origin: Extract<SessionOrigin, { kind: 'channel' }> = {
        kind: 'channel',
        adapter,
        workspace,
        chat: 'chat-a',
        thread: null,
      }
      const retrievalContext = { results: '' }
      await exports.hooks!['session.turn.start']!(
        { sessionId: `ses-${adapter}`, agentDir, userPrompt: 'query', origin, retrievalContext },
        { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
      )
      expect(retrievalContext.results).toContain(`${adapter}-chat-a-topic`)
      expect(retrievalContext.results).toContain(`${adapter}-chat-b-topic`)
    }
    expect(hybridSearchMock).not.toHaveBeenCalled()
  })

  test('nested automatic retrieval does not derive a search scope from origin ancestry', async () => {
    const scopedSearch = mock(async () => [])
    await writeOriginFragments(agentDir, [originFragment('local', 'w1', 'Local body.')])
    await writeTopic(agentDir, 'local-topic', 'Local Topic', 'Local body.\nfragments:\n- streams/2026-07-01#local')
    const exports = await bootVectorPluginWith(scopedSearch, 16384)
    const origin = {
      kind: 'subagent' as const,
      subagent: 'researcher',
      parentSessionId: 'ses_cron',
      spawnedByOrigin: {
        kind: 'cron' as const,
        jobId: 'digest',
        jobKind: 'subagent' as const,
        scheduledByOrigin: {
          kind: 'channel' as const,
          adapter: 'slack-bot' as const,
          workspace: 'w1',
          chat: 'c1',
          thread: null,
        },
      },
    }
    const retrievalContext = { results: 'sentinel' }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_nested', agentDir, userPrompt: 'query', origin, retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(scopedSearch).toHaveBeenCalledWith('query', expect.anything(), agentDir, 10, expect.any(Function))
    expect(retrievalContext.results).toContain('local-topic')
  })

  test('nested Discord DM retrieval does not derive a scope from its parent chat', async () => {
    const scopedSearch = mock(async () => [])
    const exports = await bootVectorPluginWith(scopedSearch, 16384)
    const origin = {
      kind: 'subagent' as const,
      subagent: 'researcher',
      parentSessionId: 'ses_dm',
      spawnedByOrigin: {
        kind: 'channel' as const,
        adapter: 'discord' as const,
        workspace: '@dm',
        chat: 'dm-a',
        thread: null,
      },
    }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_dm_child', agentDir, userPrompt: 'query', origin, retrievalContext: { results: '' } },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(scopedSearch).toHaveBeenCalledWith('query', expect.anything(), agentDir, 10, expect.any(Function))
  })

  test('a channel caller keeps cross-workspace heading access by default', async () => {
    await writeTopic(agentDir, 'global-a', 'Global A', 'First global belief.')
    await writeTopic(agentDir, 'global-b', 'Global B', 'Second global belief.')
    const exports = await bootVectorPlugin(16384)
    const origin = {
      kind: 'channel' as const,
      adapter: 'slack-bot' as const,
      workspace: 'w1',
      chat: 'c1',
      thread: null,
    }
    const retrievalContext = { results: '' }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_global_channel', agentDir, userPrompt: 'query', origin, retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') },
    )

    expect(retrievalContext.results).toContain('global-a')
    expect(retrievalContext.results).toContain('global-b')
  })

  test('a system-infrastructure subagent turn skips retrieval entirely (no embed, no hybrid search)', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a body')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    // given: a memory-logger-style subagent — spawned by a `system` origin, its
    // userPrompt is the static framing block, not a user message
    const origin = {
      kind: 'subagent' as const,
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
      spawnedByOrigin: { kind: 'system' as const, component: 'memory-logger' },
    }

    const retrievalContext = { results: '' }
    await hook(
      {
        sessionId: 'ses_logger',
        agentDir,
        userPrompt: 'Read the transcript past the watermark',
        origin,
        retrievalContext,
      },
      ctx,
    )

    expect(hybridSearchMock).not.toHaveBeenCalled()
    expect(retrievalContext.results).toBe('')
  })

  test('a directly-system-origin turn skips retrieval entirely', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a body')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    const origin = { kind: 'system' as const, component: 'backup' }

    const retrievalContext = { results: '' }
    await hook({ sessionId: 'ses_backup', agentDir, userPrompt: 'whatever', origin, retrievalContext }, ctx)

    expect(hybridSearchMock).not.toHaveBeenCalled()
    expect(retrievalContext.results).toBe('')
  })

  test('a user-delegated subagent turn still runs retrieval', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'a body')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    // given: a researcher-style subagent spawned by a user TUI turn, not `system`
    const origin = {
      kind: 'subagent' as const,
      subagent: 'researcher',
      parentSessionId: 'ses_parent',
      spawnedByOrigin: { kind: 'tui' as const, sessionId: 'ses_parent' },
    }

    const retrievalContext = { results: '' }
    await hook({ sessionId: 'ses_research', agentDir, userPrompt: 'find the auth flow', origin, retrievalContext }, ctx)

    expect(hybridSearchMock).toHaveBeenCalledWith(
      'find the auth flow',
      expect.anything(),
      agentDir,
      10,
      expect.any(Function),
    )
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('the dreaming cron subagent skips retrieval (cron parent, internal job id)', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a body')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    // given: the real dreaming origin — a subagent spawned by the memory plugin's
    // own cron job, so its parent is `cron`/`__plugin_memory_dreaming`, NOT `system`
    const origin = {
      kind: 'subagent' as const,
      subagent: 'dreaming',
      parentSessionId: 'ses_cron',
      spawnedByOrigin: {
        kind: 'cron' as const,
        jobId: '__plugin_memory_dreaming',
        jobKind: 'prompt' as const,
      },
    }

    const retrievalContext = { results: '' }
    await hook(
      { sessionId: 'ses_dream', agentDir, userPrompt: 'consolidate the daily stream', origin, retrievalContext },
      ctx,
    )

    expect(hybridSearchMock).not.toHaveBeenCalled()
    expect(retrievalContext.results).toBe('')
  })

  test('a user-scheduled cron subagent still runs retrieval (not the dreaming job id)', async () => {
    hybridSearchMock.mockClear()
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'a body')
    const exports = await bootVectorPlugin(16384)
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
    // given: a user-scheduled cron subagent — real delegated work, distinct job id
    const origin = {
      kind: 'subagent' as const,
      subagent: 'researcher',
      parentSessionId: 'ses_cron',
      spawnedByOrigin: {
        kind: 'cron' as const,
        jobId: 'user-nightly-digest',
        jobKind: 'prompt' as const,
      },
    }

    const retrievalContext = { results: '' }
    await hook({ sessionId: 'ses_user_cron', agentDir, userPrompt: 'summarize today', origin, retrievalContext }, ctx)

    expect(hybridSearchMock).toHaveBeenCalledWith(
      'summarize today',
      expect.anything(),
      agentDir,
      10,
      expect.any(Function),
    )
    expect(retrievalContext.results).toContain('Second topic excerpt from vector retrieval.')
  })

  test('a failing hybrid search is caught: the turn yields empty memory instead of throwing', async () => {
    // given: two over-budget shards (index mode) and a hybridSearch that rejects,
    // simulating a runtime embed/store failure (OOM, corrupt DB, model crash)
    await writeTopic(agentDir, 'first-topic', 'First Topic', 'a'.repeat(3000))
    await writeTopic(agentDir, 'second-topic', 'Second Topic', 'b'.repeat(3000))
    const errors: string[] = []
    const failingSearch = mock(async () => {
      throw new Error('embed failed: onnxruntime OOM')
    })
    const exports = await bootVectorPluginWith(failingSearch, 4096, errorCapturingLogger(errors))

    // when: a turn runs over budget so the index path calls the failing search
    const retrievalContext = { results: 'sentinel' }
    const hook = exports.hooks!['session.turn.start']!
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }

    // then: the hook resolves (does not throw) and the turn is not crashed
    await expect(
      hook({ sessionId: 'ses_fail', agentDir, userPrompt: 'q', retrievalContext }, ctx),
    ).resolves.toBeUndefined()
    expect(failingSearch).toHaveBeenCalled()
    // the pre-existing sentinel is left untouched (results was never reassigned),
    // and the failure is logged through the plugin logger, not propagated
    expect(retrievalContext.results).toBe('sentinel')
    expect(errors.some((line) => line.includes('vector-retrieval failed'))).toBe(true)
  })

  test('memory-logger subagent is created with on-write vector hooks', async () => {
    const memoryPlugin = createMemoryPluginWithStoreCapture()
    const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes: 4096 })
    if (!parsed.success) throw new Error(parsed.error.message)
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger: createPluginLogger('memory'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)

    expect(exports.subagents).toBeDefined()
    expect(exports.subagents!['memory-logger']).toBeDefined()
    const memoryLoggerSubagent = exports.subagents!['memory-logger']!
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBeGreaterThan(0)
  })
})

async function bootVectorPlugin(
  injectionBudgetBytes: number,
  logger = createPluginLogger('memory'),
  permissions: PermissionService = noopPermissionService,
) {
  const memoryPlugin = createMemoryPluginWithStoreCapture({ hybridSearch: hybridSearchMock })
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

async function bootVectorPluginWith(
  hybridSearch: typeof hybridSearchMock,
  injectionBudgetBytes: number,
  logger = createPluginLogger('memory'),
  permissions: PermissionService = noopPermissionService,
) {
  const memoryPlugin = createMemoryPluginWithStoreCapture({ hybridSearch })
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

function createMemoryPluginWithStoreCapture(overrides: Partial<MemoryPluginDeps> = {}) {
  return createMemoryPluginForTests({
    ...overrides,
    openAppendVectorStore: (dir) => () => VectorStore.open(join(dir, 'memory', '.vectors', 'index.db')),
  })
}

function capturingLogger(infos: string[]) {
  return {
    ...createPluginLogger('memory'),
    info: (msg: string) => {
      infos.push(msg)
    },
  }
}

function errorCapturingLogger(errors: string[]) {
  return {
    ...createPluginLogger('memory'),
    error: (msg: string) => {
      errors.push(msg)
    },
  }
}

async function writeTopic(
  dir: string,
  slug: string,
  heading: string,
  body: string,
  kind?: 'belief' | 'procedure' | 'environmental-incident',
): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard(
      { heading, ...(kind === undefined ? {} : { kind }), cites: 1, days: 1, lastReinforced: '2026-06-11' },
      body,
    ),
  )
}

async function writeOriginFragments(dir: string, fragments: FragmentEvent[]): Promise<void> {
  await mkdir(streamsDir(dir), { recursive: true })
  await appendEvents(streamFilePath(dir, '2026-07-01'), fragments)
}

function originFragment(id: string, workspace: string, body: string): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-07-01T12:00:00.000Z',
    source: 'ses_channel',
    entry: `entry-${id}`,
    topic: id,
    body,
    where: { adapter: 'slack-bot', workspace, chat: 'c1', thread: null },
  }
}

function retrievedTopic(key: string, heading: string, excerpt: string) {
  return { source: 'topic' as const, key, heading, excerpt, rrfScore: 1 }
}
