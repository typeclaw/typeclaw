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
})

function server(name: string): McpServer {
  return { name, command: 'server-command', args: [], env: {} }
}

function fakeConnection(name: string, tools: McpToolInfo[], closed: string[]): McpConnection {
  return {
    name,
    async listTools() {
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
