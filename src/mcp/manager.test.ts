import { describe, expect, test } from 'bun:test'

import type { McpServer } from '@/config/config'

import type { McpConnection, McpToolInfo } from './client'
import { createMcpManager, namespaceToolName, parseNamespacedTool } from './manager'

describe('MCP tool namespacing', () => {
  test('round-trips tool names that contain the separator by splitting on the first separator', () => {
    const namespaced = namespaceToolName('filesystem', 'read__file')

    expect(namespaced).toBe('filesystem__read__file')
    expect(parseNamespacedTool(namespaced)).toEqual({ server: 'filesystem', tool: 'read__file' })
  })

  test('rejects names without both sides of the separator', () => {
    expect(parseNamespacedTool('plain')).toBeUndefined()
    expect(parseNamespacedTool('__tool')).toBeUndefined()
    expect(parseNamespacedTool('server__')).toBeUndefined()
  })
})

describe('createMcpManager', () => {
  test('keeps healthy servers connected when one server fails and closes every open connection', async () => {
    const closed: string[] = []
    const servers: McpServer[] = [server('alpha'), server('broken'), server('gamma')]
    const manager = createMcpManager(servers, {
      env: {},
      async connect(mcpServer) {
        if (mcpServer.name === 'broken') throw new Error('cannot connect')
        return fakeConnection(
          mcpServer.name,
          [{ name: `${mcpServer.name}-tool`, description: '', inputSchema: {} }],
          closed,
        )
      },
    })

    const results = await manager.connectAll()

    expect(results.map((result) => ({ name: result.name, ok: result.ok }))).toEqual([
      { name: 'alpha', ok: true },
      { name: 'broken', ok: false },
      { name: 'gamma', ok: true },
    ])
    expect(manager.getConnection('alpha')?.name).toBe('alpha')
    expect(manager.getConnection('broken')).toBeUndefined()
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: true, toolCount: 1 },
      { name: 'broken', connected: false },
      { name: 'gamma', connected: true, toolCount: 1 },
    ])

    await manager.closeAll()

    expect(closed.sort()).toEqual(['alpha', 'gamma'])
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: false },
      { name: 'broken', connected: false },
      { name: 'gamma', connected: false },
    ])
  })

  test('keeps disabled servers invisible to connection lookup and server listing', async () => {
    const connected: string[] = []
    const servers: McpServer[] = [server('alpha'), server('disabled', false), server('gamma')]
    const manager = createMcpManager(servers, {
      env: {},
      async connect(mcpServer) {
        connected.push(mcpServer.name)
        return fakeConnection(
          mcpServer.name,
          [{ name: `${mcpServer.name}-tool`, description: '', inputSchema: {} }],
          [],
        )
      },
    })

    const results = await manager.connectAll()

    expect(connected).toEqual(['alpha', 'gamma'])
    expect(results.map((result) => result.name)).toEqual(['alpha', 'gamma'])
    expect(manager.getConnection('disabled')).toBeUndefined()
    expect(manager.listServers()).toEqual([
      { name: 'alpha', connected: true, toolCount: 1 },
      { name: 'gamma', connected: true, toolCount: 1 },
    ])
  })

  test('threads an abort signal to each connector', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const abort = new AbortController()
    const manager = createMcpManager([server('alpha'), server('gamma')], {
      env: {},
      async connect(mcpServer, opts) {
        signals.push(opts.signal)
        return fakeConnection(mcpServer.name, [], [])
      },
    })

    await manager.connectAll({ signal: abort.signal })

    expect(signals).toEqual([abort.signal, abort.signal])
  })

  test('refresh updates cached tool counts from live connections', async () => {
    const manager = createMcpManager([server('alpha')], {
      env: {},
      async connect(mcpServer) {
        return changingConnection(mcpServer.name)
      },
    })

    await manager.connectAll()
    expect(manager.listServers()).toEqual([{ name: 'alpha', connected: true, toolCount: 1 }])

    await manager.refresh()

    expect(manager.listServers()).toEqual([{ name: 'alpha', connected: true, toolCount: 2 }])
  })
})

function server(name: string, enabled = true): McpServer {
  return { name, enabled, command: 'server-command', args: [], env: {} }
}

function fakeConnection(name: string, tools: McpToolInfo[], closed: string[]): McpConnection {
  return {
    name,
    async listTools() {
      return tools
    },
    async refresh() {
      return tools
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {
      closed.push(name)
    },
  }
}

function changingConnection(name: string): McpConnection {
  let calls = 0
  const listTools = async (): Promise<McpToolInfo[]> => {
    calls += 1
    return Array.from({ length: calls }, (_value, index) => ({
      name: `tool-${index}`,
      description: '',
      inputSchema: {},
    }))
  }
  return {
    name,
    listTools,
    refresh: listTools,
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}
