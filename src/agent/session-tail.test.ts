import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import { createSessionWithDispose } from './index'
import type { SessionOrigin } from './session-origin'
import { appendSessionTail, persistedPromptHasInlineSessionTail } from './session-tail'

describe('appendSessionTail', () => {
  test('adds the tail as the last section of the leading system message without touching the input', () => {
    const system = { role: 'system', content: '', sections: { preamble: 'P', cwd: '<cwd>\n/a\n</cwd>' } }
    const user = { role: 'user', content: 'hi' }
    const messages: { role: string; content: string; sections?: Record<string, string> }[] = [system, user]

    const out = appendSessionTail(messages, 'TAIL')

    expect(Object.entries(out[0]!.sections ?? {}).at(-1)).toEqual(['typeclaw_session', 'TAIL'])
    expect(out[1]).toBe(user)
    expect(system.sections).toEqual({ preamble: 'P', cwd: '<cwd>\n/a\n</cwd>' })
  })

  test('leaves messages alone without a leading system message or a tail', () => {
    const messages = [{ role: 'user', content: 'hi' }]
    expect(appendSessionTail(messages, 'TAIL')).toBe(messages)
    const withSystem = [{ role: 'system', sections: { preamble: 'P' } }]
    expect(appendSessionTail(withSystem, '')).toBe(withSystem)
  })
})

describe('persistedPromptHasInlineSessionTail', () => {
  const systemEntry = (preamble: string) => ({ type: 'message', message: { role: 'system', sections: { preamble } } })

  test('recognizes a preamble written by the inline layout', () => {
    expect(persistedPromptHasInlineSessionTail([systemEntry('policy\n\n## Session origin\n\nchannel')])).toBe(true)
    expect(
      persistedPromptHasInlineSessionTail([systemEntry('policy\n\n## Uncommitted changes at session start')]),
    ).toBe(true)
  })

  test('treats a fresh transcript or a detached preamble as the new layout', () => {
    expect(persistedPromptHasInlineSessionTail([])).toBe(false)
    expect(persistedPromptHasInlineSessionTail([systemEntry('policy\n\n## MCP servers')])).toBe(false)
  })
})

describe('session requests', () => {
  let agentDir: string
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const previousOpenAiKey = process.env.OPENAI_API_KEY

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-session-tail-'))
    process.chdir(agentDir)
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-4o-mini' } }))
    reloadConfig(agentDir)
    process.env.OPENAI_API_KEY = 'test-openai-key'
    invalidateProviderAuthCache()
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  async function captureSystemPrompt(
    origin: SessionOrigin,
    sessionManager = SessionManager.inMemory(agentDir),
  ): Promise<{ system: string; base: string; persisted: unknown }> {
    const { session, dispose } = await createSessionWithDispose({ sessionManager, origin, tools: ['read'] })
    let body: { input?: { role?: string; content?: unknown }[] } | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      body = (await new Request(input, init).json()) as typeof body
      return new Response('{"error":{"message":"session tail probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      await session.prompt('hi').catch(() => {})
      const lead = body?.input?.find((item) => item.role === 'system' || item.role === 'developer')
      const content = lead?.content
      const system = typeof content === 'string' ? content : JSON.stringify(content)
      const persisted = sessionManager
        .getEntries()
        .find((entry) => entry.type === 'message' && entry.message.role === 'system')
      return { system, base: session.systemPrompt, persisted }
    } finally {
      globalThis.fetch = previousFetch
      await dispose()
    }
  }

  test('a new session sends its origin after the skills and cwd, without persisting it', async () => {
    // given two cron jobs, whose origins differ
    const first = await captureSystemPrompt({ kind: 'cron', jobId: 'job-alpha', jobKind: 'prompt' })
    const second = await captureSystemPrompt({ kind: 'cron', jobId: 'job-beta', jobKind: 'prompt' })

    // then each origin follows the cwd section, so everything before it is shared
    for (const probe of [first, second]) {
      expect(probe.system.indexOf('## Session origin')).toBeGreaterThan(probe.system.indexOf('</cwd>'))
      expect(probe.system.indexOf('</cwd>')).toBeGreaterThan(probe.system.indexOf('</skills>'))
      expect(probe.system.split('## Session origin')).toHaveLength(2)
      expect(JSON.stringify(probe.persisted)).not.toContain('## Session origin')
      expect(probe.base).not.toContain('## Session origin')
    }
    const shared = first.system.slice(0, first.system.indexOf('## Session origin'))
    expect(second.system.startsWith(shared)).toBe(true)
    expect(first.system).toContain('job-alpha')
    expect(second.system).toContain('job-beta')
  })

  test('a resumed session whose prompt already carries its origin keeps it inline, once', async () => {
    // given a transcript written by the inline layout
    const sessionManager = SessionManager.inMemory(agentDir)
    sessionManager.appendMessage({
      role: 'system',
      content: '',
      sections: { preamble: 'LEGACY-PREAMBLE\n\n## Session origin\n\nLEGACY-ORIGIN' },
      timestamp: 0,
    } as never)

    // when it resumes
    const probe = await captureSystemPrompt({ kind: 'cron', jobId: 'job-legacy', jobKind: 'prompt' }, sessionManager)

    // then its rebuilt prompt keeps the origin inline instead of appending it per request
    expect(probe.base).toContain('## Session origin')
    expect(probe.base).toContain('job-legacy')
    expect(probe.system.indexOf('## Session origin')).toBeLessThan(probe.system.indexOf('</cwd>'))
    expect(probe.system.split('## Session origin')).toHaveLength(2)
  })
})
