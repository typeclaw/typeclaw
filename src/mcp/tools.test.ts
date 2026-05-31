import { describe, expect, test } from 'bun:test'

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { ToolContext } from '@/plugin/types'

import type { McpConnection, McpToolInfo } from './client'
import type { McpManager } from './manager'
import { createMcpDispatcherTools, type McpCallArgs, type McpDescribeArgs, type McpListToolsArgs } from './tools'

describe('createMcpDispatcherTools', () => {
  test('mcp_list_tools returns namespaced tool names and descriptions', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [
        { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
        { name: 'write', description: '', inputSchema: { type: 'object' } },
      ]),
    })
    const [listTools] = createMcpDispatcherTools(manager)

    const result = await listTools.execute({ server: 'files' } satisfies McpListToolsArgs, toolContext())

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Tools for MCP server "files":\n- files__read — Read a file\n- files__write — no description',
      },
    ])
  })

  test('mcp_list_tools reports unknown servers with available server names', async () => {
    const manager = fakeManager({ files: fakeConnection('files', []) })
    const [listTools] = createMcpDispatcherTools(manager)

    const result = await listTools.execute({ server: 'missing' } satisfies McpListToolsArgs, toolContext())

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Unknown MCP server "missing". Available servers: files.',
    })
  })

  test('mcp_describe returns inputSchema JSON for bare and namespaced tool ids', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ]),
    })
    const [, describeTool] = createMcpDispatcherTools(manager)

    const bare = await describeTool.execute({ server: 'files', tool: 'read' } satisfies McpDescribeArgs, toolContext())
    const namespaced = await describeTool.execute(
      { server: 'ignored', tool: 'files__read' } satisfies McpDescribeArgs,
      toolContext(),
    )

    const text = expectText(bare.content[0])
    expect(text).toContain('MCP tool files__read')
    expect(text).toContain('Description: Read a file')
    expect(text).toContain('"path": {')
    expect(namespaced).toEqual(bare)
  })

  test('mcp_call maps text results and includes call details', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], { content: [{ type: 'text', text: 'file contents' }] }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute(
      { server: 'files', tool: 'read', args: { path: 'README.md' } } satisfies McpCallArgs,
      toolContext(),
    )

    expect(result).toEqual({
      content: [{ type: 'text', text: 'file contents' }],
      details: { server: 'files', tool: 'read', isError: false },
    })
  })

  test('mcp_call surfaces SDK error results as text instead of throwing', async () => {
    const manager = fakeManager({
      files: fakeConnection('files', [], { content: [{ type: 'text', text: 'permission denied' }], isError: true }),
    })
    const [, , callTool] = createMcpDispatcherTools(manager)

    const result = await callTool.execute({ server: 'files', tool: 'read' } satisfies McpCallArgs, toolContext())

    expect(result).toEqual({
      content: [{ type: 'text', text: 'MCP tool error: permission denied' }],
      details: { server: 'files', tool: 'read', isError: true },
    })
  })
})

function fakeManager(connections: Record<string, McpConnection>): McpManager {
  return {
    async connectAll() {
      return Object.entries(connections).map(([name, connection]) => ({
        ok: true as const,
        name,
        connection,
        toolCount: 0,
      }))
    },
    getConnection(name) {
      return connections[name]
    },
    listServers() {
      return Object.keys(connections).map((name) => ({ name, connected: true, toolCount: 0 }))
    },
    async closeAll() {},
  }
}

function fakeConnection(name: string, tools: McpToolInfo[], result?: CallToolResult): McpConnection {
  return {
    name,
    async listTools() {
      return tools
    },
    async callTool() {
      return result ?? { content: [{ type: 'text', text: 'ok' }] }
    },
    async close() {},
  }
}

function toolContext(): ToolContext {
  return {
    signal: undefined,
    sessionId: 'ses_test',
    agentDir: '/agent',
    logger: { info() {}, warn() {}, error() {} },
  }
}

function expectText(
  part: { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string } | undefined,
): string {
  expect(part?.type).toBe('text')
  if (part?.type !== 'text') throw new Error('expected text content')
  return part.text
}
