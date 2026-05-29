import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { HookBus } from '@/plugin'
import { createStream } from '@/stream'

import type { AgentSession } from './index'
import {
  createSubagentConsumer,
  invokeSubagent,
  overlaySandboxOverride,
  startSubagent,
  type Subagent,
  validateSubagentPayload,
} from './subagents'

function makeFakeHookBus(events: string[]): HookBus {
  return {
    registerAll: () => {},
    unregisterAll: () => {},
    runSessionStart: async () => {},
    runSessionEnd: async (e) => {
      events.push(`end:${e.sessionId}`)
    },
    runSessionIdle: async (e) => {
      events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
    },
    runSessionPrompt: async () => {},
    runSessionTurnStart: async () => {},
    runSessionTurnEnd: async () => {},
    runToolBefore: async () => undefined,
    runToolAfter: async () => {},
    count: () => 0,
  }
}

function fakeSession(): { session: AgentSession; calls: { prompt: string[]; disposed: number } } {
  const calls = { prompt: [] as string[], disposed: 0 }
  const session = {
    prompt: async (text: string) => {
      calls.prompt.push(text)
    },
    dispose: () => {
      calls.disposed += 1
    },
  } as unknown as AgentSession
  return { session, calls }
}

describe('validateSubagentPayload', () => {
  test('returns parsed payload when schema matches', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when
    const result = validateSubagentPayload('test', subagent, { id: 'abc' })

    // then
    expect(result).toEqual({ id: 'abc' })
  })

  test('throws when schema does not match', () => {
    // given
    const schema = z.object({ id: z.string() })
    const subagent: Subagent<{ id: string }> = { systemPrompt: 'X', payloadSchema: schema }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { id: 42 })).toThrow(/invalid payload/)
  })

  test('throws when subagent has no schema but payload is provided', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, { foo: 'bar' })).toThrow(/does not accept a payload/)
  })

  test('error message describes the received value type to disambiguate undefined vs null vs object', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when / then
    expect(() => validateSubagentPayload('test', subagent, null)).toThrow(/received null/)
    expect(() => validateSubagentPayload('test', subagent, { foo: 1 })).toThrow(/received object/)
    expect(() => validateSubagentPayload('test', subagent, [1, 2])).toThrow(/received array/)
    expect(() => validateSubagentPayload('test', subagent, 'oops')).toThrow(/received string/)
  })

  test('passes when subagent has no schema and payload is undefined', () => {
    // given
    const subagent: Subagent = { systemPrompt: 'X' }

    // when
    const result = validateSubagentPayload('test', subagent, undefined)

    // then
    expect(result).toBeUndefined()
  })
})

describe('invokeSubagent', () => {
  test('throws on unknown subagent name', async () => {
    // when / then
    await expect(
      invokeSubagent('missing', {
        registry: {},
        createSessionForSubagent: async () => fakeSession().session,
        agentDir: '/agent',
        userPrompt: 'hi',
      }),
    ).rejects.toThrow(/unknown subagent: missing/)
  })

  test('default execution prompts the session with the user prompt and disposes', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = { greeter: { systemPrompt: 'You are a greeter.' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'say hello',
    })

    // then
    expect(calls.prompt).toEqual([expect.stringContaining('say hello')])
    expect(calls.disposed).toBe(1)
  })

  test('handler receives validated payload and runs runSession when called', async () => {
    // given
    const { session, calls } = fakeSession()
    const schema = z.object({ name: z.string() })
    const registry = {
      greeter: {
        systemPrompt: 'You are a greeter.',
        payloadSchema: schema,
        handler: async (ctx, runSession) => {
          await runSession({ userPrompt: `hello ${ctx.payload.name}` })
        },
      } satisfies Subagent<{ name: string }>,
    }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'unused default',
      payload: { name: 'Neo' },
    })

    // then
    expect(calls.prompt).toEqual([expect.stringContaining('hello Neo')])
    expect(calls.disposed).toBe(1)
  })

  test('handler may skip the session entirely', async () => {
    // given
    const { session, calls } = fakeSession()
    const registry = {
      lazy: {
        systemPrompt: 'X',
        handler: async () => {
          // intentionally never call runSession
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('lazy', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'whatever',
    })

    // then
    expect(calls.prompt).toEqual([])
    expect(calls.disposed).toBe(0)
  })

  test('handler may call runSession multiple times, creating fresh sessions each time', async () => {
    // given
    const fakes: ReturnType<typeof fakeSession>[] = []
    const registry = {
      twice: {
        systemPrompt: 'X',
        handler: async (_ctx, runSession) => {
          await runSession({ userPrompt: 'first' })
          await runSession({ userPrompt: 'second' })
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('twice', {
      registry,
      createSessionForSubagent: async () => {
        const f = fakeSession()
        fakes.push(f)
        return f.session
      },
      agentDir: '/agent',
      userPrompt: 'unused',
    })

    // then
    expect(fakes).toHaveLength(2)
    expect(fakes[0]!.calls.prompt).toEqual([expect.stringContaining('first')])
    expect(fakes[1]!.calls.prompt).toEqual([expect.stringContaining('second')])
    expect(fakes[0]!.calls.disposed).toBe(1)
    expect(fakes[1]!.calls.disposed).toBe(1)
  })

  test('payload validation errors surface before any session is created', async () => {
    // given
    let createCalled = false
    const schema = z.object({ id: z.string() })
    const registry = {
      strict: { systemPrompt: 'X', payloadSchema: schema, handler: async () => {} } satisfies Subagent<{ id: string }>,
    }

    // when / then
    await expect(
      invokeSubagent('strict', {
        registry,
        createSessionForSubagent: async () => {
          createCalled = true
          return fakeSession().session
        },
        agentDir: '/agent',
        userPrompt: 'x',
        payload: { id: 42 },
      }),
    ).rejects.toThrow(/invalid payload/)
    expect(createCalled).toBe(false)
  })

  test('disposes the session even when the prompt throws', async () => {
    // given
    const calls = { disposed: 0 }
    const session = {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {
        calls.disposed += 1
      },
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => session,
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/boom/)
    expect(calls.disposed).toBe(1)
  })

  test('fires session.idle and session.end on the supplied HookBus around runSession', async () => {
    // given
    const { session } = fakeSession()
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => ({
        session,
        hooks,
        sessionId: 'sub-sess-1',
        getTranscriptPath: () => '/tmp/sub-transcript.jsonl',
      }),
      agentDir: '/agent',
      userPrompt: 'hi',
    })

    // then
    expect(events).toEqual(['idle:sub-sess-1:/tmp/sub-transcript.jsonl', 'end:sub-sess-1'])
  })

  test('fires session.end even when the prompt throws so plugins can react to abnormal subagent termination', async () => {
    // given
    const events: string[] = []
    const hooks = makeFakeHookBus(events)
    const session = {
      prompt: async () => {
        throw new Error('subagent boom')
      },
      dispose: () => {},
    } as unknown as AgentSession
    const registry = { fragile: { systemPrompt: 'X' } satisfies Subagent }

    // when / then
    await expect(
      invokeSubagent('fragile', {
        registry,
        createSessionForSubagent: async () => ({ session, hooks, sessionId: 'sub-boom' }),
        agentDir: '/agent',
        userPrompt: 'crash',
      }),
    ).rejects.toThrow(/subagent boom/)
    expect(events).toEqual(['end:sub-boom'])
  })

  test('runSession({sandbox}) threads sandboxOverride into createSessionForSubagent', async () => {
    // given
    const seen: Array<true | { mounts?: unknown } | undefined> = []
    const stagedSandbox = { network: 'none' as const, mounts: [{ src: '/tmp/x', dst: '/work', mode: 'ro' as const }] }
    const registry = {
      reviewer: {
        systemPrompt: 'X',
        handler: async (_ctx, runSession) => {
          await runSession({ sandbox: stagedSandbox })
        },
      } satisfies Subagent,
    }

    // when
    await invokeSubagent('reviewer', {
      registry,
      createSessionForSubagent: async (_sub, opts) => {
        seen.push(opts?.sandboxOverride)
        return fakeSession().session
      },
      agentDir: '/agent',
      userPrompt: 'review',
    })

    // then
    expect(seen).toEqual([stagedSandbox])
  })

  test('runSession() without sandbox leaves sandboxOverride undefined', async () => {
    // given
    const seen: Array<unknown> = []
    const registry = { plain: { systemPrompt: 'X' } satisfies Subagent }

    // when
    await invokeSubagent('plain', {
      registry,
      createSessionForSubagent: async (_sub, opts) => {
        seen.push(opts?.sandboxOverride)
        return fakeSession().session
      },
      agentDir: '/agent',
      userPrompt: 'go',
    })

    // then
    expect(seen).toEqual([undefined])
  })
})

describe('overlaySandboxOverride', () => {
  const reviewer: Subagent = { systemPrompt: 'R', sandbox: { network: 'none' } }
  const explorer: Subagent = { systemPrompt: 'E' }

  test("applies override to the spawn's own subagent", () => {
    const staged = { network: 'none' as const, mounts: [{ src: '/tmp/r', dst: '/work', mode: 'ro' as const }] }
    const result = overlaySandboxOverride(reviewer, 'reviewer', 'reviewer', staged)
    expect(result?.sandbox).toBe(staged)
  })

  test('does not mutate the shared registry entry', () => {
    const staged = { network: 'none' as const, mounts: [{ src: '/tmp/r', dst: '/work', mode: 'ro' as const }] }
    overlaySandboxOverride(reviewer, 'reviewer', 'reviewer', staged)
    expect(reviewer.sandbox).toEqual({ network: 'none' })
  })

  test('leaves a different subagent untouched even when an override is set', () => {
    const staged = { network: 'none' as const }
    const result = overlaySandboxOverride(explorer, 'explorer', 'reviewer', staged)
    expect(result).toBe(explorer)
    expect(result?.sandbox).toBeUndefined()
  })

  test('returns undefined for a registry miss', () => {
    expect(overlaySandboxOverride(undefined, 'gone', 'reviewer', { network: 'none' })).toBeUndefined()
  })

  test('no cross-talk: two overlays from one base resolve to their own sandbox', () => {
    const s1 = { network: 'none' as const, mounts: [{ src: '/tmp/a', dst: '/work', mode: 'ro' as const }] }
    const s2 = { network: 'none' as const, mounts: [{ src: '/tmp/b', dst: '/work', mode: 'ro' as const }] }
    const r1 = overlaySandboxOverride(reviewer, 'reviewer', 'reviewer', s1)
    const r2 = overlaySandboxOverride(reviewer, 'reviewer', 'reviewer', s2)
    expect(r1?.sandbox).toBe(s1)
    expect(r2?.sandbox).toBe(s2)
    expect(reviewer.sandbox).toEqual({ network: 'none' })
  })

  test('no override (undefined) returns the entry unchanged', () => {
    const result = overlaySandboxOverride(reviewer, 'reviewer', 'reviewer', undefined)
    expect(result).toBe(reviewer)
  })
})

describe('createSubagentConsumer', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} }

  function fakeAgentSession(prompts: string[]): AgentSession {
    return {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      dispose: () => {},
    } as unknown as AgentSession
  }

  test('dispatches a new-session message to the registered subagent handler', async () => {
    // given
    const stream = createStream()
    const handlerCalls: { payload: unknown }[] = []
    const registry = {
      greeter: {
        systemPrompt: 'X',
        payloadSchema: z.object({ who: z.string() }),
        handler: async (ctx) => {
          handlerCalls.push({ payload: ctx.payload })
        },
      } satisfies Subagent<{ who: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: silent,
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'greeter' }, payload: { who: 'neo' } })
    await new Promise((r) => setImmediate(r))

    // then
    expect(handlerCalls).toEqual([{ payload: { who: 'neo' } }])

    consumer.stop()
  })

  test('warns and ignores messages for unregistered subagent names', async () => {
    // given
    const stream = createStream()
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => ({}),
      agentDir: '/agent',
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'no-such-thing' }, payload: null })
    await new Promise((r) => setImmediate(r))

    // then
    expect(warnings.some((w) => /no registered subagent/.test(w))).toBe(true)

    consumer.stop()
  })

  test('coalesces concurrent invocations using inFlightKey', async () => {
    // given: a slow subagent and an inFlightKey that ignores payload, so two
    // concurrent messages collapse into one execution.
    const stream = createStream()
    const handlerCalls: number[] = []
    let resolveFirst: () => void = () => {}
    const registry = {
      slow: {
        systemPrompt: 'X',
        handler: async () => {
          handlerCalls.push(1)
          await new Promise<void>((r) => {
            resolveFirst = r
          })
        },
      } satisfies Subagent,
    }
    const warnings: string[] = []
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name) => name,
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when: two messages fire while the first is still running
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: only one handler call so far; the second was coalesced
    expect(handlerCalls).toEqual([1])
    expect(warnings.some((w) => /previous run still in progress/.test(w))).toBe(true)

    resolveFirst()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('different inFlightKey buckets allow concurrent execution', async () => {
    // given
    const stream = createStream()
    const concurrent: string[] = []
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const registry = {
      bucketed: {
        systemPrompt: 'X',
        payloadSchema: z.object({ id: z.string() }),
        handler: async (ctx) => {
          concurrent.push(`start:${ctx.payload.id}`)
          await gate
          concurrent.push(`end:${ctx.payload.id}`)
        },
      } satisfies Subagent<{ id: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name, payload) => `${name}:${(payload as { id: string }).id}`,
      logger: silent,
    })
    consumer.start()

    // when: two messages with different IDs fire while the first is gated
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'a' } })
    stream.publish({ target: { kind: 'new-session', subagent: 'bucketed' }, payload: { id: 'b' } })
    await new Promise((r) => setImmediate(r))

    // then: both handlers started before either finished
    expect(concurrent.filter((s) => s.startsWith('start:'))).toEqual(['start:a', 'start:b'])

    releaseGate()
    await new Promise((r) => setImmediate(r))
    consumer.stop()
  })

  test('removes inFlight entry when handler throws', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const registry = {
      explodes: {
        systemPrompt: 'X',
        handler: async () => {
          throw new Error('boom')
        },
      } satisfies Subagent,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: { ...silent, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'explodes' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then: the error was logged and inFlight is now empty
    expect(errors.some((e) => /boom/.test(e))).toBe(true)
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('timeoutMs releases the inFlight coalesce key when a spawn exceeds its ceiling', async () => {
    // given: a subagent whose handler never settles (mirrors a wedged
    // provider call) and a 30ms timeoutMs. Without the ceiling, the second
    // spawn would stay coalesce-skipped forever; with it, the timeout fires,
    // the key releases, and the second spawn proceeds.
    const stream = createStream()
    const warnings: string[] = []
    const completions: string[] = []
    let firstStarted = false
    const registry = {
      wedge: {
        systemPrompt: 'X',
        timeoutMs: 30,
        handler: async () => {
          if (!firstStarted) {
            firstStarted = true
            await new Promise<void>(() => {})
            return
          }
          completions.push('second')
        },
      } satisfies Subagent,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      logger: { ...silent, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    // when: first spawn wedges, then a second spawn fires after the timeout
    stream.publish({ target: { kind: 'new-session', subagent: 'wedge' }, payload: undefined })
    await new Promise((r) => setTimeout(r, 50))
    stream.publish({ target: { kind: 'new-session', subagent: 'wedge' }, payload: undefined })
    await new Promise((r) => setTimeout(r, 30))

    // then: the timeout was logged with attribution, the coalesce key was
    // released, and the second spawn ran to completion.
    expect(warnings.some((w) => /timed out after 30ms/.test(w) && /releasing coalesce key/.test(w))).toBe(true)
    expect(completions).toEqual(['second'])
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('undefined timeoutMs preserves legacy behavior (waits for the spawn to settle)', async () => {
    // given: a slow subagent with no timeoutMs. The first spawn must
    // complete before the second runs — same coalescing semantics as before
    // this surface existed.
    const stream = createStream()
    const completions: string[] = []
    let releaseFirst: () => void = () => {}
    const registry = {
      slow: {
        systemPrompt: 'X',
        handler: async (ctx) => {
          const id = (ctx.payload as { id: string }).id
          if (id === 'first') {
            await new Promise<void>((r) => {
              releaseFirst = r
            })
          }
          completions.push(id)
        },
        payloadSchema: z.object({ id: z.string() }),
      } satisfies Subagent<{ id: string }>,
    }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => fakeAgentSession([]),
      inFlightKey: (name) => name,
      logger: silent,
    })
    consumer.start()

    // when: two spawns fire while the first is gated
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: { id: 'first' } })
    await new Promise((r) => setImmediate(r))
    stream.publish({ target: { kind: 'new-session', subagent: 'slow' }, payload: { id: 'second' } })
    await new Promise((r) => setImmediate(r))

    // then: only the first started; the second was coalesce-skipped
    expect(completions).toEqual([])

    // when: release the first
    releaseFirst()
    await new Promise((r) => setImmediate(r))

    // then: only the first completed; the coalesce-skipped second was dropped
    // by the consumer (not re-queued) — same as today's behavior.
    expect(completions).toEqual(['first'])
    expect(consumer.inFlightCount()).toBe(0)

    consumer.stop()
  })

  test('logs LLM soft errors emitted via message_end during prompt() so `typeclaw logs` surfaces them', async () => {
    // given: a subagent whose underlying session emits a message_end with
    // stopReason=error during prompt(), mirroring how pi-coding-agent
    // reports billing/rate-limit failures (resolves normally, doesn't throw).
    const stream = createStream()
    const errors: string[] = []
    type Listener = (event: { type: string; message?: unknown }) => void
    const sessionWithSubscribe = (): AgentSession => {
      const listeners = new Set<Listener>()
      return {
        prompt: async () => {
          for (const cb of listeners) {
            cb({
              type: 'message_end',
              message: { role: 'assistant', stopReason: 'error', errorMessage: 'billing failed' },
            })
          }
        },
        dispose: () => {},
        subscribe: (cb: Listener) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      } as unknown as AgentSession
    }
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    const consumer = createSubagentConsumer({
      stream,
      getRegistry: () => registry,
      agentDir: '/agent',
      createSessionForSubagent: async () => sessionWithSubscribe(),
      logger: { ...silent, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    stream.publish({ target: { kind: 'new-session', subagent: 'greeter' }, payload: undefined })
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors.some((e) => /\[subagent\] greeter: LLM call failed: billing failed/.test(e))).toBe(true)

    consumer.stop()
  })
})

describe('startSubagent', () => {
  function subscribableFakeSession(): {
    session: AgentSession
    calls: { prompt: string[]; disposed: number }
    emit: (event: unknown) => void
  } {
    const calls = { prompt: [] as string[], disposed: 0 }
    let listener: ((event: unknown) => void) | null = null
    const session = {
      prompt: async (text: string) => {
        calls.prompt.push(text)
      },
      dispose: () => {
        calls.disposed += 1
      },
      subscribe: (l: (event: unknown) => void) => {
        listener = l
        return () => {
          listener = null
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    return {
      session,
      calls,
      emit: (event) => listener?.(event),
    }
  }

  test('handle promise resolves before completion settles, with the taskId we provided', async () => {
    // given
    const { session } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { handle, completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'hi',
      taskId: 'bg_xyz',
    })

    // then
    const h = await handle
    expect(h.taskId).toBe('bg_xyz')
    await completion
  })

  test('completion resolves ok=true when prompt finishes', async () => {
    // given
    const { session, calls } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'hello',
      taskId: 'bg_1',
    })
    const result = await completion

    // then
    expect(result.ok).toBe(true)
    expect(calls.prompt).toEqual([expect.stringContaining('hello')])
    expect(calls.disposed).toBe(1)
  })

  test('completion captures the final assistant message', async () => {
    // given
    let listener: ((event: unknown) => void) | null = null
    const session = {
      prompt: async () => {
        listener?.({
          type: 'message_end',
          message: { content: 'Found 42 results.' },
        })
      },
      dispose: () => {},
      subscribe: (l: (event: unknown) => void) => {
        listener = l
        return () => {
          listener = null
        }
      },
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_msg',
    })
    const result = await completion

    // then
    if (result.ok) {
      expect(result.finalMessage).toBe('Found 42 results.')
    } else {
      throw new Error(`expected ok=true, got error: ${result.error}`)
    }
  })

  test('completion resolves ok=false with error message when prompt throws', async () => {
    // given
    const session = {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_err',
    })
    const result = await completion

    // then
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('boom')
    }
  })

  test('onSession fires once with the live session and abort handle', async () => {
    // given
    const { session } = subscribableFakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    let captured: { abortCount: number } | null = null

    // when
    const { completion } = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'q',
      taskId: 'bg_session',
      onSession: (event) => {
        captured = { abortCount: 0 }
        void event.abort().then(() => {
          if (captured) captured.abortCount += 1
        })
      },
    })
    await completion

    // then
    expect(captured).not.toBeNull()
    expect(captured!.abortCount).toBe(1)
  })

  test('parallel starts with different taskIds run concurrently (proves handle settles independently)', async () => {
    // given
    let resolveProm1: () => void = () => {}
    let resolveProm2: () => void = () => {}
    const session1 = {
      prompt: async () =>
        new Promise<void>((r) => {
          resolveProm1 = r
        }),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const session2 = {
      prompt: async () =>
        new Promise<void>((r) => {
          resolveProm2 = r
        }),
      dispose: () => {},
      subscribe: () => () => {},
      abort: async () => {},
    } as unknown as AgentSession
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }
    let createCount = 0

    // when
    const start1 = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => {
        createCount += 1
        return session1
      },
      agentDir: '/agent',
      userPrompt: 'q1',
      taskId: 'bg_a',
    })
    const start2 = startSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => {
        createCount += 1
        return session2
      },
      agentDir: '/agent',
      userPrompt: 'q2',
      taskId: 'bg_b',
    })
    const h1 = await start1.handle
    const h2 = await start2.handle

    // then
    expect(h1.taskId).toBe('bg_a')
    expect(h2.taskId).toBe('bg_b')
    expect(createCount).toBe(2)
    // Both handles resolved before either prompt finished — proves non-blocking shape.
    resolveProm1()
    resolveProm2()
    await Promise.all([start1.completion, start2.completion])
  })

  test('invokeSubagent (the wrapper) still returns Promise<void> and runs unchanged', async () => {
    // given (this asserts no behavioral regression from the refactor)
    const { session, calls } = fakeSession()
    const registry = { greeter: { systemPrompt: 'X' } satisfies Subagent }

    // when
    const result = await invokeSubagent('greeter', {
      registry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      userPrompt: 'wrapper',
    })

    // then
    expect(result).toBeUndefined()
    expect(calls.prompt).toEqual([expect.stringContaining('wrapper')])
    expect(calls.disposed).toBe(1)
  })
})
