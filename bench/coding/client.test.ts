import { afterEach, describe, expect, test } from 'bun:test'

import { runTask } from './client'
import type { BenchServerMessage } from './protocol'

type FakeServer = {
  url: string
  stop: () => void
}

const servers: FakeServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

function startFakeServer(script: BenchServerMessage[]): string {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response('expected websocket', { status: 426 })
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: 'connected', sessionId: 'test-session' }))
      },
      message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as { type: string }
        if (parsed.type !== 'prompt') return
        for (const message of script) ws.send(JSON.stringify(message))
      },
    },
  })
  const url = `ws://127.0.0.1:${server.port}`
  servers.push({ url, stop: () => server.stop(true) })
  return url
}

describe('runTask', () => {
  test('collects text, tool calls, and usage up to the first done', async () => {
    const url = startFakeServer([
      { type: 'prompt_started', messageId: 'm1', text: 'go' },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'tool_start', toolCallId: 't1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_end', toolCallId: 't1', name: 'bash', error: false, result: 'ok', durationMs: 12 },
      { type: 'done', usage: { input: 10, output: 5, totalTokens: 15, cost: 0.001 } },
    ])

    const result = await runTask({ url, prompt: 'do the thing' })

    expect(result.error).toBeNull()
    expect(result.text).toBe('Hello world')
    expect(result.toolCalls).toEqual([
      { toolCallId: 't1', name: 'bash', args: { cmd: 'ls' }, result: 'ok', isError: false, durationMs: 12 },
    ])
    expect(result.usage).toEqual({ input: 10, output: 5, totalTokens: 15, cost: 0.001 })
  })

  test('stops at the first done and ignores a todo-continuation turn', async () => {
    const url = startFakeServer([
      { type: 'text_delta', delta: 'main turn' },
      { type: 'done' },
      { type: 'prompt_started', messageId: 'm2', text: 'continue' },
      { type: 'text_delta', delta: 'CONTINUATION LEAK' },
      { type: 'done' },
    ])

    const result = await runTask({ url, prompt: 'x' })

    expect(result.text).toBe('main turn')
    expect(result.text).not.toContain('CONTINUATION LEAK')
  })

  test('surfaces an error frame as a failed turn', async () => {
    const url = startFakeServer([
      { type: 'text_delta', delta: 'partial' },
      { type: 'error', message: 'model exploded' },
    ])

    const result = await runTask({ url, prompt: 'x' })

    expect(result.error).toBe('model exploded')
    expect(result.text).toBe('partial')
  })

  test('times out the connect handshake against a non-listening url', async () => {
    await expect(runTask({ url: 'ws://127.0.0.1:1', prompt: 'x', connectTimeoutMs: 200 })).rejects.toThrow()
  })
})
