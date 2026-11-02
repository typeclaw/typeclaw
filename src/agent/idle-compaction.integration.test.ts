import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'
import FakeTimers from '@sinonjs/fake-timers'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import { COMPACTION_ABSOLUTE_TRIGGER_TOKENS } from './compaction'
import { createSessionWithDispose } from './index'

const previousCwd = process.cwd()
const previousEnv = process.env.NODE_ENV
const previousFetch = globalThis.fetch
let agentDir: string | undefined

afterEach(async () => {
  globalThis.fetch = previousFetch
  if (previousEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousEnv
  invalidateProviderAuthCache()
  __resetConfigForTesting()
  process.chdir(previousCwd)
  if (agentDir) await rm(agentDir, { recursive: true, force: true })
})

test('session creation wires idle compaction through the real provider request path', async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-idle-integration-'))
  await writeFile(
    join(agentDir, 'typeclaw.json'),
    JSON.stringify({
      models: { default: 'anthropic/claude-sonnet-5' },
    }),
  )
  process.chdir(agentDir)
  process.env.NODE_ENV = 'test'
  invalidateProviderAuthCache()
  reloadConfig(agentDir)
  const sessionManager = SessionManager.inMemory(agentDir)
  for (let i = 0; i < 10; i++) {
    sessionManager.appendMessage({
      role: 'user',
      content: 'history '.repeat(2_500),
      timestamp: i,
    })
  }
  const { session, dispose } = await createSessionWithDispose({
    sessionManager,
    systemPromptOverride: 'test',
    tools: [],
  })
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests++
      // Past the 90% idle-warmup threshold, still under the trigger itself.
      const tokens = requests === 1 ? Math.round(COMPACTION_ABSOLUTE_TRIGGER_TOKENS * 0.94) : 100
      const events = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: `message-${requests}`,
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              content: [],
              usage: { input_tokens: tokens, output_tokens: 0 },
            },
          },
        ],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'result' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      return new Response(
        events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
    { preconnect: previousFetch.preconnect },
  )
  const clock = FakeTimers.install()
  try {
    await session.prompt('finish')
    expect(sessionManager.getBranch().filter((entry) => entry.type === 'compaction')).toHaveLength(0)

    await clock.runAllAsync()

    expect(requests).toBeGreaterThan(1)
    expect(sessionManager.getBranch().filter((entry) => entry.type === 'compaction')).toHaveLength(1)
    expect(session.messages).toEqual(sessionManager.buildSessionContext().messages)
  } finally {
    clock.uninstall()
    session.dispose()
    await dispose()
  }
})
