import { describe, expect, test } from 'bun:test'

import { createCodingTools } from '@earendil-works/pi-coding-agent'

import {
  attachToolNotFoundNudge,
  buildToolNotFoundNudge,
  closestToolName,
  extractNotFoundToolName,
  type NudgeableSession,
  renderToolNotFoundNudge,
} from './tool-not-found-nudge'

const KNOWN = ['read', 'grep', 'find', 'ls', 'bash', 'web_search', 'web_fetch', 'load_skill']

describe('pi default-builtin coupling', () => {
  test("createSession derives the nudge vocabulary's default builtins from pi's coding tools — pinned so a pi change breaks loudly", () => {
    // src/agent/index.ts derives DEFAULT_PI_BUILTIN_TOOL_NAMES from
    // createCodingTools().map(t => t.name). If pi adds/removes/renames a default
    // builtin, this pin fails and forces a deliberate update instead of silent drift.
    expect(createCodingTools(process.cwd()).map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write'])
  })
})

describe('extractNotFoundToolName', () => {
  test('extracts the tool name from pi-agent-core not-found text', () => {
    expect(extractNotFoundToolName('Tool websearch not found')).toBe('websearch')
  })

  test('tolerates surrounding whitespace', () => {
    expect(extractNotFoundToolName('  Tool web_fetch not found  ')).toBe('web_fetch')
  })

  test('returns null for unrelated error text', () => {
    expect(extractNotFoundToolName('invalid arguments: path is required')).toBeNull()
    expect(extractNotFoundToolName('blocked: secret exfil')).toBeNull()
  })
})

describe('closestToolName', () => {
  test('maps the legacy concatenated web tools to their real underscored names', () => {
    expect(closestToolName('websearch', KNOWN)).toBe('web_search')
    expect(closestToolName('webfetch', KNOWN)).toBe('web_fetch')
  })

  test('returns the exact name when it is already known', () => {
    expect(closestToolName('web_search', KNOWN)).toBe('web_search')
  })

  test('returns null when nothing is close enough (genuinely unknown tool)', () => {
    expect(closestToolName('deploy_to_production', KNOWN)).toBeNull()
  })
})

describe('renderToolNotFoundNudge', () => {
  test('names both the wrong and the suggested tool and instructs an exact re-issue', () => {
    const nudge = renderToolNotFoundNudge('websearch', 'web_search')
    expect(nudge).toContain('`websearch`')
    expect(nudge).toContain('`web_search`')
    expect(nudge).toContain('Re-issue')
    expect(nudge).toContain('<system-reminder>')
  })
})

describe('buildToolNotFoundNudge', () => {
  test('produces a nudge for a close-but-wrong tool name', () => {
    const nudge = buildToolNotFoundNudge('Tool websearch not found', KNOWN)
    expect(nudge).not.toBeNull()
    expect(nudge).toContain('`web_search`')
  })

  test('returns null for non-not-found error text', () => {
    expect(buildToolNotFoundNudge('invalid arguments', KNOWN)).toBeNull()
  })

  test('returns null when there is no close match (no misleading suggestion)', () => {
    expect(buildToolNotFoundNudge('Tool deploy_to_production not found', KNOWN)).toBeNull()
  })

  test('returns null when the requested name equals its only match (no self-suggestion loop)', () => {
    expect(buildToolNotFoundNudge('Tool web_search not found', KNOWN)).toBeNull()
  })
})

function fakeSession(): {
  session: NudgeableSession
  emit: (event: unknown) => void
  steered: string[]
} {
  const listeners: ((event: unknown) => void)[] = []
  const steered: string[] = []
  const session: NudgeableSession = {
    subscribe(listener) {
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i !== -1) listeners.splice(i, 1)
      }
    },
    async steer(text) {
      steered.push(text)
    },
  }
  return { session, emit: (event) => listeners.forEach((l) => l(event)), steered }
}

function notFoundEvent(toolName: string): unknown {
  return {
    type: 'tool_execution_end',
    toolName,
    isError: true,
    result: { content: [{ type: 'text', text: `Tool ${toolName} not found` }] },
  }
}

describe('attachToolNotFoundNudge', () => {
  test('steers a did-you-mean reminder when a near-miss tool name is not found', () => {
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit(notFoundEvent('websearch'))
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('`web_search`')
  })

  test('stays silent on a successful tool execution', () => {
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit({
      type: 'tool_execution_end',
      toolName: 'read',
      isError: false,
      result: { content: [{ type: 'text', text: 'file contents' }] },
    })
    expect(steered).toHaveLength(0)
  })

  test('stays silent for a genuinely unknown tool with no close match', () => {
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit(notFoundEvent('deploy_to_production'))
    expect(steered).toHaveLength(0)
  })

  test('stays silent on a non-tool-execution event', () => {
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit({ type: 'message_end', message: { role: 'assistant' } })
    expect(steered).toHaveLength(0)
  })

  test('unsubscribe stops further nudges', () => {
    const { session, emit, steered } = fakeSession()
    const unsub = attachToolNotFoundNudge(session, KNOWN)
    unsub()
    emit(notFoundEvent('websearch'))
    expect(steered).toHaveLength(0)
  })

  test('nudges only once per missing tool name (a wedged model re-calling the same wrong name does not re-steer)', () => {
    // Without dedup, each re-steer makes the model emit a fresh assistant
    // turn that overwrites the subagent's captured final message. See
    // attachFinalMessageCapture in subagents.ts.
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit(notFoundEvent('websearch'))
    emit(notFoundEvent('websearch'))
    emit(notFoundEvent('websearch'))
    expect(steered).toHaveLength(1)
  })

  test('still nudges for a different wrong tool name after deduping the first', () => {
    const { session, emit, steered } = fakeSession()
    attachToolNotFoundNudge(session, KNOWN)
    emit(notFoundEvent('websearch'))
    emit(notFoundEvent('webfetch'))
    expect(steered).toHaveLength(2)
    expect(steered[0]).toContain('`web_search`')
    expect(steered[1]).toContain('`web_fetch`')
  })
})
