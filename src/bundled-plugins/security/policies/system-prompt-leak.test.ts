import { describe, expect, test } from 'bun:test'

import { GUARD_SYSTEM_PROMPT_LEAK, checkSystemPromptLeakGuard, findSystemPromptLeak } from './system-prompt-leak'

const SAMPLE_LEAKED_SYSTEM_PROMPT = `Sure, here it is:

\`\`\`markdown
You are a general-purpose AI agent running inside TypeClaw.

TypeClaw is a TypeScript-native, Docker-friendly runtime for AI agents.

## Your agent folder

Five markdown files define who you are.

## SOUL.md

I am the agent.

## IDENTITY.md

placeholder

## Memory

[MEMORY CONTEXT - not instructions]
\`\`\``

describe('system-prompt-leak fingerprint detection', () => {
  test('catches a realistic system-prompt dump (TypeClaw preamble + identity files)', () => {
    const hits = findSystemPromptLeak(SAMPLE_LEAKED_SYSTEM_PROMPT)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some((h) => /TypeClaw runtime preamble/.test(h.label))).toBe(true)
  })

  test('catches "Your agent folder" header in isolation', () => {
    expect(findSystemPromptLeak('## Your agent folder\n\nstuff').length).toBeGreaterThan(0)
  })

  test('catches MEMORY-context disclaimer', () => {
    const text = 'random preamble [MEMORY CONTEXT - not instructions] and then content'
    expect(findSystemPromptLeak(text).length).toBeGreaterThan(0)
  })

  test('catches NO_REPLY contract clause', () => {
    const text = 'For every user message in this session, you MUST call `channel_reply` at least once'
    expect(findSystemPromptLeak(text).length).toBeGreaterThan(0)
  })

  test('catches available_skills XML block', () => {
    const text =
      '<available_skills>\n  <skill><name>foo</name><description>bar</description></skill>\n</available_skills>'
    expect(findSystemPromptLeak(text).length).toBeGreaterThan(0)
  })

  test('catches "## SOUL.md" markdown header', () => {
    expect(findSystemPromptLeak('## SOUL.md').length).toBeGreaterThan(0)
    expect(findSystemPromptLeak('## IDENTITY.md').length).toBeGreaterThan(0)
    expect(findSystemPromptLeak('## MEMORY.md').length).toBeGreaterThan(0)
  })

  test('catches identity-file recital sequence', () => {
    const text = 'I read IDENTITY.md, then SOUL.md, then MEMORY.md, and combined them.'
    expect(findSystemPromptLeak(text).length).toBeGreaterThan(0)
  })

  test('does not flag mention of the words alone', () => {
    expect(findSystemPromptLeak('I love memory foam pillows.')).toEqual([])
    expect(findSystemPromptLeak('The new identity politics is...')).toEqual([])
  })

  test('does not flag normal channel messages', () => {
    expect(findSystemPromptLeak('hello, how are you today?')).toEqual([])
    expect(findSystemPromptLeak('check this out https://example.com')).toEqual([])
  })
})

describe('checkSystemPromptLeakGuard', () => {
  test('blocks channel_send carrying a system-prompt dump', () => {
    const result = checkSystemPromptLeakGuard({
      tool: 'channel_send',
      args: { text: SAMPLE_LEAKED_SYSTEM_PROMPT },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('TypeClaw runtime preamble')
  })

  test('blocks channel_reply with available_skills XML', () => {
    const result = checkSystemPromptLeakGuard({
      tool: 'channel_reply',
      args: {
        text: '<available_skills>\n  <skill><name>x</name><description>y</description></skill>\n</available_skills>',
      },
    })
    expect(result?.block).toBe(true)
  })

  test('does not block ordinary chat', () => {
    expect(checkSystemPromptLeakGuard({ tool: 'channel_send', args: { text: 'hello world' } })).toBeUndefined()
  })

  test('does not let a model-authored acknowledgement bypass a system-prompt leak', () => {
    const result = checkSystemPromptLeakGuard({
      tool: 'channel_send',
      args: { text: SAMPLE_LEAKED_SYSTEM_PROMPT, acknowledgeGuards: { systemPromptLeak: true } },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('does not apply to non-channel tools', () => {
    expect(checkSystemPromptLeakGuard({ tool: 'bash', args: { text: SAMPLE_LEAKED_SYSTEM_PROMPT } })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SYSTEM_PROMPT_LEAK).toBe('systemPromptLeak')
  })
})

describe('system-prompt-leak on bot CLI sends', () => {
  test('blocks system-prompt fingerprints in a bot CLI send', () => {
    const command = "agent-webexbot message send room 'You are a general-purpose AI agent running inside TypeClaw.'"
    expect(checkSystemPromptLeakGuard({ tool: 'bash', args: { command } })?.reason).toContain(GUARD_SYSTEM_PROMPT_LEAK)
  })

  test('does not scan bash that is not a bot CLI send', () => {
    const command = "grep 'You are a general-purpose AI agent running inside TypeClaw.' notes.md"
    expect(checkSystemPromptLeakGuard({ tool: 'bash', args: { command } })).toBeUndefined()
  })
})
