import { describe, expect, test } from 'bun:test'

import type { McpConnectResult, McpManager } from '@/mcp'

import { connectMcpAndLoadPlugins } from './connect-mcp-and-load-plugins'

describe('connectMcpAndLoadPlugins', () => {
  test('closes MCP connections and rethrows when the plugin load fails fatally', async () => {
    // given: a slow MCP connect that settles AFTER the plugin load has already rejected
    let closed = 0
    let connectSettled = false
    const manager = fakeManager({
      async connectAll() {
        await delay(20)
        connectSettled = true
        return [{ ok: true, name: 'files', connection: undefined as never, toolCount: 0 }]
      },
      async closeAll() {
        closed += 1
      },
    })
    const fatal = new Error('bundled plugin blew up')

    // when / then: the plugin error surfaces, but only after MCP settled and was closed
    await expect(
      connectMcpAndLoadPlugins(manager, async () => {
        throw fatal
      }),
    ).rejects.toBe(fatal)
    expect(connectSettled).toBe(true)
    expect(closed).toBe(1)
  })

  test('returns the plugin result and does not close MCP on success', async () => {
    let closed = 0
    const manager = fakeManager({
      async connectAll() {
        return [
          { ok: true, name: 'files', connection: undefined as never, toolCount: 1 },
          { ok: false, name: 'broken', error: new Error('nope') },
        ]
      },
      async closeAll() {
        closed += 1
      },
    })

    const result = await connectMcpAndLoadPlugins(manager, async () => 'plugins')

    expect(result).toBe('plugins')
    expect(closed).toBe(0)
  })

  test('works with no MCP manager configured', async () => {
    const result = await connectMcpAndLoadPlugins(null, async () => 42)
    expect(result).toBe(42)
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeManager(overrides: Partial<McpManager>): McpManager {
  return {
    async connectAll(): Promise<McpConnectResult[]> {
      return []
    },
    getConnection() {
      return undefined
    },
    listServers() {
      return []
    },
    async refresh() {
      return []
    },
    async closeAll() {},
    ...overrides,
  }
}
