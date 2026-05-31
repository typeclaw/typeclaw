import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { defineTool } from '@/plugin/define'
import type { ContentPart, Tool, ToolResult } from '@/plugin/types'

import type { McpManager } from './manager'
import { namespaceToolName, parseNamespacedTool } from './manager'

export const MCP_DISPATCHER_TOOL_NAMES = ['mcp_list_tools', 'mcp_describe', 'mcp_call'] as const

export type McpListToolsArgs = { server: string }
export type McpDescribeArgs = { server: string; tool: string }
export type McpCallArgs = { server: string; tool: string; args?: Record<string, unknown> }
export type McpDispatcherTool = Tool<McpListToolsArgs> | Tool<McpDescribeArgs> | Tool<McpCallArgs>
export type McpDispatcherTools = [Tool<McpListToolsArgs>, Tool<McpDescribeArgs>, Tool<McpCallArgs>]

export function createMcpDispatcherTools(manager: McpManager): McpDispatcherTools {
  return [createListToolsTool(manager), createDescribeTool(manager), createCallTool(manager)]
}

function createListToolsTool(manager: McpManager): Tool<McpListToolsArgs> {
  return defineTool<McpListToolsArgs>({
    description: 'List the tools exposed by one connected MCP server. Returns namespaced tool ids and descriptions.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
    }),
    async execute(args) {
      const connection = manager.getConnection(args.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, args.server))

      const tools = await connection.listTools()
      if (tools.length === 0) return textResult(`MCP server ${JSON.stringify(args.server)} exposes no tools.`)

      const lines = tools.map((tool) => {
        const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
        return `- ${namespaceToolName(args.server, tool.name)} — ${description}`
      })
      return textResult(`Tools for MCP server ${JSON.stringify(args.server)}:\n${lines.join('\n')}`)
    },
  })
}

function createDescribeTool(manager: McpManager): Tool<McpDescribeArgs> {
  return defineTool<McpDescribeArgs>({
    description: 'Describe one MCP tool. Returns its description and full input JSON Schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
    }),
    async execute(args) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = manager.getConnection(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      const tools = await connection.listTools()
      const tool = tools.find((item) => item.name === resolved.tool)
      if (tool === undefined) {
        const available = tools.map((item) => namespaceToolName(resolved.server, item.name)).join(', ')
        return textResult(
          `Unknown MCP tool ${JSON.stringify(resolved.tool)} on server ${JSON.stringify(resolved.server)}. Available tools: ${available || 'none'}.`,
        )
      }

      const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
      return textResult(
        [
          `MCP tool ${namespaceToolName(resolved.server, tool.name)}`,
          `Description: ${description}`,
          '',
          'Input schema:',
          '```json',
          JSON.stringify(tool.inputSchema, null, 2),
          '```',
        ].join('\n'),
      )
    },
  })
}

function createCallTool(manager: McpManager): Tool<McpCallArgs> {
  return defineTool<McpCallArgs>({
    description: 'Call an MCP tool on a connected server. Use mcp_describe first to learn the input schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments matching the tool input schema.'),
    }),
    async execute(args) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = manager.getConnection(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      const result = await connection.callTool(resolved.tool, args.args ?? {})
      return mapCallToolResult(resolved.server, resolved.tool, result)
    },
  })
}

function resolveToolArgs(server: string, tool: string): { server: string; tool: string } {
  const parsed = parseNamespacedTool(tool)
  return parsed ?? { server, tool }
}

function unknownServerMessage(manager: McpManager, server: string): string {
  const available = manager
    .listServers()
    .filter((entry) => entry.connected)
    .map((entry) => entry.name)
    .join(', ')
  return `Unknown MCP server ${JSON.stringify(server)}. Available servers: ${available || 'none'}.`
}

function mapCallToolResult(server: string, tool: string, result: CallToolResult): ToolResult {
  const content = result.content.flatMap((part): ContentPart[] => {
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text }]
    return []
  })
  const textContent: { type: 'text'; text: string }[] =
    content.length > 0
      ? content.filter((part) => part.type === 'text')
      : [{ type: 'text', text: JSON.stringify(result.content) }]
  if (result.isError === true) {
    return {
      content: textContent.map((part) => ({ type: 'text' as const, text: `MCP tool error: ${part.text}` })),
      details: { server, tool, isError: true },
    }
  }
  return { content: textContent, details: { server, tool, isError: false } }
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
