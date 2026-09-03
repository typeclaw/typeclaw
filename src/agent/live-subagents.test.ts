import { describe, expect, test } from 'bun:test'

import {
  LiveSubagentRegistry,
  MAX_EVENTS_PER_SUBAGENT,
  MESSAGE_PREVIEW_CHARS,
  type LiveSubagent,
  type SubagentProgressEvent,
  attachProgressCapture,
  coarsen,
  newestRunningBackgroundChildStartedAt,
} from './live-subagents'

function makeLive(overrides: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    taskId: 'bg_t1',
    sessionId: 'ses_s1',
    subagentName: 'explorer',
    parentSessionId: 'ses_p1',
    startedAt: 1_000,
    status: 'running',
    abort: async () => {},
    ...overrides,
  }
}

describe('coarsen', () => {
  test('tool_execution_end → tool event with ok=true when isError=false', () => {
    const result = coarsen(
      {
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'grep',
        result: 'matches found',
        isError: false,
      },
      5_000,
    )
    expect(result).toEqual({ kind: 'tool', name: 'grep', ok: true, ts: 5_000 })
  })

  test('tool_execution_end with isError=true → tool event with ok=false', () => {
    const result = coarsen(
      {
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'bash',
        result: 'error',
        isError: true,
      },
      5_000,
    )
    expect(result).toEqual({ kind: 'tool', name: 'bash', ok: false, ts: 5_000 })
  })

  test('tool_execution_start → null (we only capture _end events; starts without ends look like the subagent is stuck)', () => {
    const result = coarsen(
      {
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'grep',
        args: { pattern: 'foo' },
      },
      5_000,
    )
    expect(result).toBeNull()
  })

  test('message_update with text_delta → null (text deltas are token-level, too noisy for progress)', () => {
    const result = coarsen(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } },
      5_000,
    )
    expect(result).toBeNull()
  })

  test('message_end with string content → message event with preview', () => {
    const result = coarsen(
      {
        type: 'message_end',
        message: { content: 'Hello world, this is the final assistant message.' },
      },
      5_000,
    )
    expect(result).toEqual({
      kind: 'message',
      preview: 'Hello world, this is the final assistant message.',
      ts: 5_000,
    })
  })

  test('message_end with array content → extracts first text part', () => {
    const result = coarsen(
      {
        type: 'message_end',
        message: {
          content: [
            { type: 'tool_use', name: 'grep' },
            { type: 'text', text: 'Found 3 matches' },
          ],
        },
      },
      5_000,
    )
    expect(result).toEqual({ kind: 'message', preview: 'Found 3 matches', ts: 5_000 })
  })

  test('message_end with long content → truncates to MESSAGE_PREVIEW_CHARS', () => {
    const longText = 'x'.repeat(500)
    const result = coarsen({ type: 'message_end', message: { content: longText } }, 5_000)
    expect(result?.kind).toBe('message')
    if (result?.kind === 'message') {
      expect(result.preview.length).toBe(MESSAGE_PREVIEW_CHARS)
    }
  })

  test('message_end with empty content → null', () => {
    const result = coarsen({ type: 'message_end', message: { content: '' } }, 5_000)
    expect(result).toBeNull()
  })

  test('unknown event type → null', () => {
    const result = coarsen({ type: 'something_else' }, 5_000)
    expect(result).toBeNull()
  })
})

describe('LiveSubagentRegistry', () => {
  test('register + get round-trip', () => {
    const reg = new LiveSubagentRegistry()
    const live = makeLive()
    reg.register(live)
    expect(reg.get('bg_t1')).toBe(live)
  })

  test('register seeds the events ring with a started event', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    const snap = reg.snapshot('bg_t1', 1_500)
    expect(snap?.eventsCount).toBe(1)
    expect(snap?.lastActivity).toEqual({ kind: 'started', ts: 1_000 })
  })

  test('register rejects duplicate taskId', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    expect(() => reg.register(makeLive())).toThrow('already registered')
  })

  test('list filters by parentSessionId', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ taskId: 'bg_a', parentSessionId: 'ses_p1' }))
    reg.register(makeLive({ taskId: 'bg_b', parentSessionId: 'ses_p1' }))
    reg.register(makeLive({ taskId: 'bg_c', parentSessionId: 'ses_p2' }))
    expect(
      reg
        .list({ parentSessionId: 'ses_p1' })
        .map((e) => e.taskId)
        .sort(),
    ).toEqual(['bg_a', 'bg_b'])
    expect(reg.list({ parentSessionId: 'ses_p2' }).map((e) => e.taskId)).toEqual(['bg_c'])
    expect(reg.list().length).toBe(3)
  })

  test('unregister removes entry and events', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    reg.unregister('bg_t1')
    expect(reg.get('bg_t1')).toBeUndefined()
    expect(reg.snapshot('bg_t1')).toBeUndefined()
  })

  test('recordEvent appends and FIFO-evicts at MAX_EVENTS_PER_SUBAGENT', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    for (let i = 0; i < MAX_EVENTS_PER_SUBAGENT + 50; i++) {
      reg.recordEvent('bg_t1', { kind: 'tool', name: `t${i}`, ok: true, ts: 2000 + i })
    }
    const snap = reg.snapshot('bg_t1', 3_000)
    expect(snap?.eventsCount).toBe(MAX_EVENTS_PER_SUBAGENT)
    const tail = snap?.eventsRecent.at(-1) as Extract<SubagentProgressEvent, { kind: 'tool' }>
    expect(tail?.name).toBe(`t${MAX_EVENTS_PER_SUBAGENT + 49}`)
  })

  test('snapshot.eventsRecent returns the last 10 events only', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    for (let i = 0; i < 30; i++) {
      reg.recordEvent('bg_t1', { kind: 'tool', name: `t${i}`, ok: true, ts: 2000 + i })
    }
    const snap = reg.snapshot('bg_t1', 3_000)
    expect(snap?.eventsRecent.length).toBe(10)
  })

  test('recordCompletion flips status to completed on ok=true', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    reg.recordCompletion('bg_t1', { ok: true, finalMessage: 'done', durationMs: 5_000 })
    expect(reg.get('bg_t1')?.status).toBe('completed')
  })

  test('recordCompletion flips status to failed on ok=false', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    reg.recordCompletion('bg_t1', { ok: false, error: 'boom', durationMs: 5_000 })
    expect(reg.get('bg_t1')?.status).toBe('failed')
  })

  test('hasLiveForSession finds running entries by sessionId', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ taskId: 'bg_a', sessionId: 'ses_x' }))
    expect(reg.hasLiveForSession('ses_x')).toBe(true)
    reg.recordCompletion('bg_a', { ok: true, durationMs: 1 })
    expect(reg.hasLiveForSession('ses_x')).toBe(false)
  })

  test('recordCompletionIfRunning: the first writer wins and returns true', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    expect(reg.recordCompletionIfRunning('bg_t1', { ok: false, error: 'timeout', durationMs: 100 })).toBe(true)
    expect(reg.get('bg_t1')?.status).toBe('failed')
    expect(reg.get('bg_t1')?.completion?.error).toBe('timeout')
  })

  test('recordCompletionIfRunning: a second writer loses, returns false, and does NOT overwrite', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())

    // given: the timeout path settled first
    reg.recordCompletionIfRunning('bg_t1', { ok: false, error: 'timeout', durationMs: 100 })

    // when: the real completion arrives afterwards
    const won = reg.recordCompletionIfRunning('bg_t1', { ok: true, finalMessage: 'late success', durationMs: 200 })

    // then: it loses and the first (timeout) outcome stays canonical
    expect(won).toBe(false)
    expect(reg.get('bg_t1')?.status).toBe('failed')
    expect(reg.get('bg_t1')?.completion?.error).toBe('timeout')
    expect(reg.get('bg_t1')?.completion?.finalMessage).toBeUndefined()
  })

  test('recordCompletionIfRunning: returns false for an unknown taskId', () => {
    const reg = new LiveSubagentRegistry()
    expect(reg.recordCompletionIfRunning('nope', { ok: true, durationMs: 1 })).toBe(false)
  })

  test('captured final output is readable while running and cannot be added after settlement', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())

    expect(reg.recordCapturedFinalMessageIfRunning('bg_t1', '<review>safe</review>')).toBe(true)
    expect(reg.getCapturedFinalMessage('bg_t1')).toBe('<review>safe</review>')

    reg.recordCompletionIfRunning('bg_t1', { ok: false, error: 'timeout', durationMs: 100 })
    expect(reg.recordCapturedFinalMessageIfRunning('bg_t1', '<review>late</review>')).toBe(false)
    expect(reg.getCapturedFinalMessage('bg_t1')).toBe('<review>safe</review>')
  })

  test('cancelRunningByWorkKey cancels matching roots and all running descendants by session ancestry', async () => {
    const reg = new LiveSubagentRegistry()
    const released: string[] = []
    const aborted: string[] = []
    const workKey = 'reviewer:github:acme/widgets#42'
    const register = (overrides: Partial<LiveSubagent>): void => {
      const taskId = overrides.taskId ?? 'missing-task'
      reg.register(
        makeLive({
          ...overrides,
          taskId,
          releaseCoalesceKey: () => released.push(taskId),
          abort: async () => {
            expect(reg.get(taskId)?.status).toBe('failed')
            expect(released).toContain(taskId)
            aborted.push(taskId)
          },
        }),
      )
    }
    register({ taskId: 'bg_root', sessionId: 'ses_root', workKey })
    register({ taskId: 'bg_child', sessionId: 'ses_child', parentSessionId: 'ses_root' })
    register({ taskId: 'bg_grandchild', sessionId: 'ses_grandchild', parentSessionId: 'ses_child' })

    const result = await reg.cancelRunningByWorkKey(workKey, 'pull request converted to draft')

    expect(result).toEqual({ matched: 3, cancelled: 3, failures: 0 })
    expect(aborted.sort()).toEqual(['bg_child', 'bg_grandchild', 'bg_root'])
    expect(released.sort()).toEqual(['bg_child', 'bg_grandchild', 'bg_root'])
    expect(reg.list().every((entry) => entry.completion?.error?.includes('pull request converted to draft'))).toBe(true)
  })

  test('cancelRunningByWorkKey follows ancestry through a terminal intermediate without cancelling unrelated PRs', async () => {
    const reg = new LiveSubagentRegistry()
    const aborted: string[] = []
    const abort = (taskId: string) => async (): Promise<void> => {
      aborted.push(taskId)
    }
    reg.register(
      makeLive({
        taskId: 'bg_target',
        sessionId: 'ses_target',
        workKey: 'reviewer:github:acme/widgets#42',
        abort: abort('bg_target'),
      }),
    )
    reg.register(
      makeLive({
        taskId: 'bg_finished_child',
        sessionId: 'ses_finished_child',
        parentSessionId: 'ses_target',
        status: 'completed',
        completion: { ok: true, durationMs: 5 },
        abort: abort('bg_finished_child'),
      }),
    )
    reg.register(
      makeLive({
        taskId: 'bg_nested_running',
        sessionId: 'ses_nested_running',
        parentSessionId: 'ses_finished_child',
        abort: abort('bg_nested_running'),
      }),
    )
    reg.register(
      makeLive({
        taskId: 'bg_other_pr',
        sessionId: 'ses_other_pr',
        workKey: 'reviewer:github:acme/widgets#43',
        abort: abort('bg_other_pr'),
      }),
    )
    reg.register(
      makeLive({
        taskId: 'bg_other_repo',
        sessionId: 'ses_other_repo',
        workKey: 'reviewer:github:acme/gadgets#42',
        abort: abort('bg_other_repo'),
      }),
    )

    const result = await reg.cancelRunningByWorkKey(
      'reviewer:github:acme/widgets#42',
      'pull request converted to draft',
    )

    expect(result).toEqual({ matched: 2, cancelled: 2, failures: 0 })
    expect(aborted.sort()).toEqual(['bg_nested_running', 'bg_target'])
    expect(reg.get('bg_finished_child')?.status).toBe('completed')
    expect(reg.get('bg_other_pr')?.status).toBe('running')
    expect(reg.get('bg_other_repo')?.status).toBe('running')
  })

  test('cancelRunningByWorkKey settlement wins over a late real completion', async () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ workKey: 'reviewer:github:acme/widgets#42' }))

    await reg.cancelRunningByWorkKey('reviewer:github:acme/widgets#42', 'pull request converted to draft')
    const lateWon = reg.recordCompletionIfRunning('bg_t1', {
      ok: true,
      finalMessage: 'late review result',
      durationMs: 200,
    })

    expect(lateWon).toBe(false)
    expect(reg.get('bg_t1')?.completion).toEqual({
      ok: false,
      error: expect.stringContaining('pull request converted to draft'),
      durationMs: expect.any(Number),
    })
  })

  test('cancelRunningByWorkKey counts an abort failure and continues cancelling siblings', async () => {
    const reg = new LiveSubagentRegistry()
    const aborted: string[] = []
    const workKey = 'reviewer:github:acme/widgets#42'
    reg.register(
      makeLive({
        taskId: 'bg_throwing',
        sessionId: 'ses_throwing',
        workKey,
        abort: async () => {
          throw new Error('abort transport failed')
        },
      }),
    )
    reg.register(
      makeLive({
        taskId: 'bg_sibling',
        sessionId: 'ses_sibling',
        workKey,
        abort: async () => {
          aborted.push('bg_sibling')
        },
      }),
    )

    const result = await reg.cancelRunningByWorkKey(workKey, 'pull request converted to draft')

    expect(result).toEqual({ matched: 2, cancelled: 1, failures: 1 })
    expect(aborted).toEqual(['bg_sibling'])
    expect(reg.get('bg_throwing')?.status).toBe('failed')
    expect(reg.get('bg_sibling')?.status).toBe('failed')
  })
})

describe('snapshot.statusSummary rendering', () => {
  test('running, 0 events beyond started → "Running for Xs. 1 event so far. Last: ..."', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 1_000 }))
    const snap = reg.snapshot('bg_t1', 4_000)
    expect(snap?.statusSummary).toMatch(/Running for 3s/)
  })

  test('running, with last activity = tool → mentions tool name', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 1_000 }))
    reg.recordEvent('bg_t1', { kind: 'tool', name: 'grep', ok: true, ts: 3_500 })
    const snap = reg.snapshot('bg_t1', 4_000)
    expect(snap?.statusSummary).toContain('Last: tool grep')
  })

  test('running with failed tool → "Last: failed tool <name>"', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 1_000 }))
    reg.recordEvent('bg_t1', { kind: 'tool', name: 'bash', ok: false, ts: 3_500 })
    const snap = reg.snapshot('bg_t1', 4_000)
    expect(snap?.statusSummary).toContain('Last: failed tool bash')
  })

  test('completed → "Completed in Xs."', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 1_000 }))
    reg.recordCompletion('bg_t1', { ok: true, finalMessage: 'done', durationMs: 5_000 })
    const snap = reg.snapshot('bg_t1', 6_500)
    expect(snap?.statusSummary).toBe('Completed in 5s.')
  })

  test('failed → "Failed after Xs: <error>"', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 1_000 }))
    reg.recordCompletion('bg_t1', { ok: false, error: 'provider timeout', durationMs: 3_000 })
    const snap = reg.snapshot('bg_t1', 5_000)
    expect(snap?.statusSummary).toBe('Failed after 3s: provider timeout')
  })

  test('elapsed formatting: ms, sec, minute', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive({ startedAt: 0 }))
    expect(reg.snapshot('bg_t1', 500)?.statusSummary).toMatch(/500ms/)
    expect(reg.snapshot('bg_t1', 5_000)?.statusSummary).toMatch(/5s/)
    expect(reg.snapshot('bg_t1', 75_000)?.statusSummary).toMatch(/1m15s/)
  })
})

describe('attachProgressCapture', () => {
  test('subscribes session events and records coarsened progress', () => {
    const reg = new LiveSubagentRegistry()
    reg.register(makeLive())
    type Listener = (event: unknown) => void
    let captured: Listener | null = null
    const fakeSession = {
      subscribe(listener: Listener) {
        captured = listener
        return () => {
          captured = null
        }
      },
    } as unknown as Parameters<typeof attachProgressCapture>[2]
    const unsub = attachProgressCapture(reg, 'bg_t1', fakeSession)
    expect(captured).not.toBeNull()
    const emit = captured as unknown as Listener
    emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: 'ok', isError: false })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
    const snap = reg.snapshot('bg_t1', 1_000)
    expect(snap?.eventsCount).toBe(2)
    const tools = snap?.eventsRecent.filter((e) => e.kind === 'tool') ?? []
    expect(tools).toHaveLength(1)
    expect((tools[0] as Extract<SubagentProgressEvent, { kind: 'tool' }>).name).toBe('read')
    unsub()
  })
})

describe('newestRunningBackgroundChildStartedAt', () => {
  function child(over: Partial<LiveSubagent>): LiveSubagent {
    return {
      taskId: 'bg_t',
      sessionId: 'ses_child',
      subagentName: 'reviewer',
      startedAt: 1_000,
      status: 'running',
      background: true,
      abort: async () => {},
      ...over,
    }
  }

  test('no children means nothing to wait for', () => {
    expect(newestRunningBackgroundChildStartedAt([])).toBeNull()
  })

  test('ignores a running FOREGROUND child: it returns inline, so no parent waits on it', () => {
    expect(newestRunningBackgroundChildStartedAt([child({ background: false })])).toBeNull()
    expect(newestRunningBackgroundChildStartedAt([child({ background: undefined })])).toBeNull()
  })

  test('ignores finished children', () => {
    const finished = [child({ status: 'completed' }), child({ status: 'failed' })]
    expect(newestRunningBackgroundChildStartedAt(finished)).toBeNull()
  })

  test('returns the NEWEST running background child so an older sibling cannot unpin the parent', () => {
    const children = [
      child({ taskId: 'bg_old', startedAt: 1_000 }),
      child({ taskId: 'bg_new', startedAt: 9_000 }),
      child({ taskId: 'bg_mid', startedAt: 5_000 }),
    ]
    expect(newestRunningBackgroundChildStartedAt(children)).toBe(9_000)
  })

  test('a newer foreground child does not mask an older running background child', () => {
    const children = [
      child({ taskId: 'bg_bg', startedAt: 1_000 }),
      child({ taskId: 'bg_fg', startedAt: 9_000, background: false }),
    ]
    expect(newestRunningBackgroundChildStartedAt(children)).toBe(1_000)
  })
})
