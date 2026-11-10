import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import * as agentIndex from '@/agent'
import type { AgentSession, CreateSessionOptions } from '@/agent'
import { invokeSubagent } from '@/agent/subagents'

import { createReviewerSubagent, REVIEWER_SKILLS, REVIEWER_SYSTEM_PROMPT } from './reviewer'

// Capture the actual createSession boundary, without provider requests. Each
// invocation owns fresh listeners and a distinct verdict, like independent runs.
function captureSessions(firstMessage?: string) {
  const sessions: { options: CreateSessionOptions; prompts: string[]; disposed: boolean }[] = []
  const create = spyOn(agentIndex, 'createSession').mockImplementation(async (options = {}) => {
    const record = { options, prompts: [] as string[], disposed: false }
    sessions.push(record)
    const listeners = new Set<(event: unknown) => void>()
    const verdict = `<review><summary>session ${sessions.length}</summary><verdict>approve</verdict></review>`
    return {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      prompt: async (text: string) => {
        record.prompts.push(text)
        for (const listener of listeners) {
          listener({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: record.prompts.length === 1 && firstMessage !== undefined ? firstMessage : verdict,
            },
          })
        }
      },
      dispose: () => {
        record.disposed = true
      },
    } as unknown as AgentSession
  })
  afterEach(() => create.mockRestore())
  return sessions
}

function reviewerRegistry() {
  // Same shared declaration as the runtime shim; builtin/plugin tool resolution
  // belongs to the native factory and is covered by its existing tests.
  const { tools: _tools, customTools: _customTools, ...reviewer } = createReviewerSubagent()
  return { reviewer }
}

describe('explicit reviewer skill prefix', () => {
  test.each([...REVIEWER_SKILLS])(
    'preserves all $name bytes before varying tasks in independent sessions',
    async (skill) => {
      const sessions = captureSessions()
      const registry = reviewerRegistry()
      const results: string[] = []
      for (const prompt of ['Review change alpha', '변경 베타를 검토해 주세요']) {
        await invokeSubagent('reviewer', {
          registry,
          agentDir: '/agent',
          userPrompt: prompt,
          payload: { prompt, skill: skill.name, systemPrompt: 'untrusted replacement' },
          spawnedByRole: 'member',
          parentSessionId: 'parent-review',
          onFinalMessageCaptured: (text) => results.push(text),
        })
      }

      expect(sessions).toHaveLength(2)
      const prefix = sessions[0]?.options.systemPromptOverride ?? ''
      expect(prefix.startsWith(REVIEWER_SYSTEM_PROMPT)).toBe(true)
      expect(prefix.endsWith(skill.content)).toBe(true)
      expect(Buffer.from(prefix).includes(Buffer.from(skill.content))).toBe(true)
      expect(sessions[1]?.options.systemPromptOverride).toBe(prefix)
      for (const other of REVIEWER_SKILLS.filter((candidate) => candidate.name !== skill.name)) {
        expect(prefix.includes(other.content)).toBe(false)
      }
      expect(prefix).not.toContain('untrusted replacement')
      expect(sessions.map((session) => session.prompts.length)).toEqual([1, 1])
      expect(sessions[0]?.prompts[0]).toContain('Review change alpha')
      expect(sessions[1]?.prompts[0]).toContain('변경 베타를 검토해 주세요')
      expect(results).toEqual([
        '<review><summary>session 1</summary><verdict>approve</verdict></review>',
        '<review><summary>session 2</summary><verdict>approve</verdict></review>',
      ])
      expect(sessions.map((session) => session.disposed)).toEqual([true, true])
      expect(sessions[0]?.options.origin).toEqual({
        kind: 'subagent',
        subagent: 'reviewer',
        parentSessionId: 'parent-review',
        spawnedByRole: 'member',
      })
      expect(registry.reviewer.systemPrompt).toBe(REVIEWER_SYSTEM_PROMPT)
    },
  )

  test('unspecified and ambiguous tasks keep dynamic selection and ignore raw prompt payload fields', async () => {
    const sessions = captureSessions()
    for (const prompt of ['Review code and documentation', '검토해 주세요']) {
      await invokeSubagent('reviewer', {
        registry: reviewerRegistry(),
        agentDir: '/agent',
        userPrompt: prompt,
        payload: { prompt, systemPrompt: 'untrusted replacement' },
      })
    }
    expect(sessions.map((session) => session.options.systemPromptOverride)).toEqual([
      REVIEWER_SYSTEM_PROMPT,
      REVIEWER_SYSTEM_PROMPT,
    ])
    const tool = createReviewerSubagent().customTools?.[0]
    for (const skill of REVIEWER_SKILLS) {
      expect(tool?.parameters.safeParse({ name: skill.name }).success).toBe(true)
    }
  })

  test('selected skill still requires and captures a verdict after a missing-block turn', async () => {
    const sessions = captureSessions('I examined the target.')
    const results: string[] = []
    await invokeSubagent('reviewer', {
      registry: reviewerRegistry(),
      agentDir: '/agent',
      userPrompt: 'Review the target',
      payload: { skill: 'general' },
      onFinalMessageCaptured: (text) => results.push(text),
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.prompts).toHaveLength(2)
    expect(results.at(-1)).toBe('<review><summary>session 1</summary><verdict>approve</verdict></review>')
  })

  test.each(['unknown', '', ['code-review'], null].map((skill) => [skill] as const))(
    'rejects invalid selection %j before session creation',
    async (skill) => {
      const sessions = captureSessions()
      await expect(
        invokeSubagent('reviewer', {
          registry: reviewerRegistry(),
          agentDir: '/agent',
          userPrompt: 'Review this',
          payload: { skill },
        }),
      ).rejects.toThrow(/invalid payload/)
      expect(sessions).toHaveLength(0)
    },
  )

  test('matched task pair moves skill bytes from dynamic tool results into a shared system prefix', async () => {
    const sessions = captureSessions()
    const reviewer = createReviewerSubagent()
    const skill = REVIEWER_SKILLS[0]
    const loader = reviewer.customTools?.[0]
    if (skill === undefined || loader === undefined) throw new Error('curated skill loader missing')
    const loaded = await loader.execute(loader.parameters.parse({ name: skill.name }), {
      signal: undefined,
      sessionId: 'review-measurement',
      agentDir: '/agent',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const dynamicSkill = loaded.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    const tasks = ['Review alpha', 'Review beta']
    for (const prompt of tasks) {
      for (const selection of [{}, { skill: skill.name }]) {
        await invokeSubagent('reviewer', {
          registry: reviewerRegistry(),
          agentDir: '/agent',
          userPrompt: prompt,
          payload: { prompt, ...selection },
        })
      }
    }
    const selected = [sessions[1], sessions[3]]
    const dynamic = [sessions[0], sessions[2]]
    // Matched deterministic context layouts, not live model behavior or cache
    // telemetry. The old path returns these same bytes after the varying task.
    expect(dynamic.map((session) => session?.options.systemPromptOverride)).toEqual([
      REVIEWER_SYSTEM_PROMPT,
      REVIEWER_SYSTEM_PROMPT,
    ])
    for (const session of selected) {
      expect(session?.options.systemPromptOverride?.endsWith(dynamicSkill)).toBe(true)
    }
    expect(selected[0]?.options.systemPromptOverride).toBe(selected[1]?.options.systemPromptOverride)
    for (const [baseline, preloaded] of [
      [dynamic[0], selected[0]],
      [dynamic[1], selected[1]],
    ]) {
      const { systemPromptOverride: _baselinePrompt, ...baselineOptions } = baseline?.options ?? {}
      const { systemPromptOverride: _selectedPrompt, ...selectedOptions } = preloaded?.options ?? {}
      expect(selectedOptions).toEqual(baselineOptions)
    }
    const bytes = Buffer.byteLength(dynamicSkill)
    console.info(
      `reviewer matched bytes: tasks=${tasks.length}, skillBytes=${bytes}, ` +
        `dynamicPostTaskSkillBytes=${bytes * tasks.length}, selectedPostTaskSkillBytes=0, ` +
        `selectedSharedSkillPrefixBytes=${bytes}; layout measurement only, no token or cache-rate claim`,
    )
  })
})
